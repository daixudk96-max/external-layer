import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredReplay {
  status: number;
  body: string;
  contentType: string;
  createdAt: number;
}

export interface IdempotencyConfig {
  /** 幂等状态 JSON 文件；缺省 = 仅内存 */
  statePath?: string;
  /** 幂等回放 TTL 毫秒；缺省 600000；0 = 关闭回放 */
  idempotencyTtlMs?: number;
}

export interface ReplayResult {
  status: number;
  body: string;
  contentType: string;
}

/**
 * 递归对对象的 key 按字典序排序，生成稳定的规范 JSON 字符串。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * 提取幂等键：优先使用 Idempotency-Key 请求头，无该头时用标准请求体的稳定序列化 sha256。
 */
export function deriveIdempotencyKey(
  headerKey: string | null | undefined,
  standardBody: Record<string, unknown>,
): string {
  const explicit = headerKey?.trim();
  if (explicit && explicit.length > 0) {
    return explicit;
  }
  return createHash("sha256").update(stableStringify(standardBody)).digest("hex");
}

export class IdempotencyStore {
  private readonly entries = new Map<string, StoredReplay>();
  private readonly inFlight = new Map<string, Promise<ReplayResult>>();
  private readonly statePath?: string;
  private readonly ttlMs: number;

  constructor(config: IdempotencyConfig = {}) {
    this.statePath = config.statePath;
    this.ttlMs = config.idempotencyTtlMs ?? 600000;
    this.loadFromDisk();
  }

  public isEnabled(): boolean {
    return this.ttlMs > 0;
  }

  private loadFromDisk(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, StoredReplay>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        if (this.ttlMs > 0 && now - entry.createdAt < this.ttlMs) {
          this.entries.set(key, entry);
        }
      }
    } catch {
      // 状态文件若读取或解析失败，容错跳过
    }
  }

  private persistSync(): void {
    if (!this.statePath) return;
    try {
      const dir = dirname(this.statePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const now = Date.now();
      const obj: Record<string, StoredReplay> = {};
      for (const [k, v] of this.entries.entries()) {
        if (now - v.createdAt < this.ttlMs) {
          obj[k] = v;
        }
      }
      const tmpPath = `${this.statePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(obj), "utf-8");
      renameSync(tmpPath, this.statePath);
    } catch (err) {
      console.warn(`[external-layer] failed to persist idempotency state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public get(key: string): StoredReplay | undefined {
    if (!this.isEnabled()) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  public save(key: string, result: ReplayResult): void {
    if (!this.isEnabled()) return;
    if (result.status < 200 || result.status >= 300) return;
    const entry: StoredReplay = {
      ...result,
      createdAt: Date.now(),
    };
    this.entries.set(key, entry);
    this.persistSync();
  }

  public async runWithDeduplication(
    key: string,
    fn: () => Promise<ReplayResult>,
  ): Promise<ReplayResult> {
    if (!this.isEnabled()) {
      return fn();
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        const result = await fn();
        if (result.status >= 200 && result.status < 300) {
          this.save(key, result);
        }
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }
}
