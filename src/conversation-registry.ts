import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
 * 针对消息项提取关键规范字段并计算 sha256 摘要。
 * 忽略内部临时 passthrough 元数据，保证摘要稳定。
 */
export function canonicalItemDigest(item: unknown): string {
  if (!item || typeof item !== "object") {
    return createHash("sha256").update(stableStringify(item)).digest("hex");
  }
  const record = item as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  if (record.type !== undefined) clean.type = record.type;
  if (record.role !== undefined) clean.role = record.role;
  if (record.call_id !== undefined) clean.call_id = record.call_id;
  if (record.output !== undefined) clean.output = record.output;
  if (record.name !== undefined) clean.name = record.name;
  if (record.arguments !== undefined) clean.arguments = record.arguments;
  if (record.summary !== undefined) clean.summary = record.summary;
  if (record.encrypted_content !== undefined) clean.encrypted_content = record.encrypted_content;

  if (typeof record.content === "string") {
    clean.content = record.content;
  } else if (Array.isArray(record.content)) {
    clean.content = record.content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") return p.text;
        return p;
      }
      return part;
    });
  } else if (record.content !== undefined) {
    clean.content = record.content;
  }

  return createHash("sha256").update(stableStringify(clean)).digest("hex");
}

export interface ConversationRecord {
  threadId: string;
  itemDigests: string[];
  responseIds: string[];
  lastUsedAt: number;
}

export interface ConversationRegistryConfig {
  limit?: number;
  statePath?: string;
}

export class ConversationRegistry {
  private readonly entries = new Map<string, ConversationRecord>();
  private readonly responseIdToThread = new Map<string, string>();
  private readonly limit: number;
  private readonly statePath?: string;

  constructor(config: ConversationRegistryConfig = {}) {
    this.limit = config.limit ?? 64;
    this.statePath = config.statePath;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, ConversationRecord>;
      const records = Object.values(parsed);
      records.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      for (const record of records) {
        this.entries.set(record.threadId, record);
        for (const respId of record.responseIds) {
          this.responseIdToThread.set(respId, record.threadId);
        }
      }
      this.evictIfNeeded();
    } catch (err) {
      console.warn(`[external-layer] failed to load conversations state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private persistSync(): void {
    if (!this.statePath) return;
    try {
      const dir = dirname(this.statePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const obj: Record<string, ConversationRecord> = {};
      for (const [k, v] of this.entries.entries()) {
        obj[k] = v;
      }
      const tmpPath = `${this.statePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(obj), "utf-8");
      renameSync(tmpPath, this.statePath);
    } catch (err) {
      console.warn(`[external-layer] failed to persist conversations state: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.limit) {
      const oldestKey = this.entries.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      if (oldest) {
        for (const respId of oldest.responseIds) {
          this.responseIdToThread.delete(respId);
        }
      }
      this.entries.delete(oldestKey);
    }
  }

  /**
   * 解析对话线程标识：
   * 1. 若携带 previous_response_id，且匹配已记录的对话，优先返回；
   * 2. 匹配已记录历史前缀（或 identical resend），最长公共前缀优先；
   * 3. 若无匹配，铸造新的 thread_id。
   */
  public resolveConversation(
    items: unknown[],
    previousResponseId?: string,
    promptCacheKey?: string,
  ): { threadId: string; isNew: boolean } {
    // 1. previous_response_id 优先
    if (previousResponseId && previousResponseId.trim().length > 0) {
      const threadId = this.responseIdToThread.get(previousResponseId.trim());
      if (threadId && this.entries.has(threadId)) {
        const record = this.entries.get(threadId)!;
        record.lastUsedAt = Date.now();
        this.entries.delete(threadId);
        this.entries.set(threadId, record);
        return { threadId, isNew: false };
      }
    }

    // DSH uses prompt_cache_key as its stable session ID. Hash it, never persist the raw key.
    // Unlike history guessing, this also works before the first HTTP response reaches EOF.
    if (typeof promptCacheKey === "string" && promptCacheKey.trim()) {
      const threadId = `prov-session-${createHash("sha256").update(promptCacheKey).digest("hex")}`;
      return { threadId, isNew: !this.entries.has(threadId) };
    }

    // 2. 历史前缀匹配
    if (items.length > 0) {
      const incomingDigests = items.map(canonicalItemDigest);
      let bestMatch: ConversationRecord | null = null;
      let maxMatchedPrefixLen = -1;

      for (const record of this.entries.values()) {
        // An anonymous history must not borrow an explicitly identified client's session.
        if (record.threadId.startsWith("prov-session-")) continue;
        const rec = record.itemDigests;
        if (rec.length <= incomingDigests.length && rec.length > 0) {
          let matches = true;
          for (let i = 0; i < rec.length; i += 1) {
            if (rec[i] !== incomingDigests[i]) {
              matches = false;
              break;
            }
          }
          if (matches) {
            if (
              rec.length > maxMatchedPrefixLen ||
              (rec.length === maxMatchedPrefixLen && bestMatch && record.lastUsedAt > bestMatch.lastUsedAt)
            ) {
              bestMatch = record;
              maxMatchedPrefixLen = rec.length;
            }
          }
        }
      }

      if (bestMatch) {
        bestMatch.lastUsedAt = Date.now();
        this.entries.delete(bestMatch.threadId);
        this.entries.set(bestMatch.threadId, bestMatch);
        return { threadId: bestMatch.threadId, isNew: false };
      }
    }

    // 3. 全新会话
    const freshThreadId = `prov-${randomUUID()}`;
    return { threadId: freshThreadId, isNew: true };
  }

  /**
   * 记录成功的轮次：更新该会话的最新 items 与 response_id，并维持 LRU 容量与落盘。
   */
  public recordTurn(threadId: string, items: unknown[], responseId?: string): void {
    const incomingDigests = items.map(canonicalItemDigest);
    let record = this.entries.get(threadId);
    if (!record) {
      record = {
        threadId,
        itemDigests: incomingDigests,
        responseIds: responseId ? [responseId] : [],
        lastUsedAt: Date.now(),
      };
    } else {
      record.itemDigests = incomingDigests;
      if (responseId && !record.responseIds.includes(responseId)) {
        record.responseIds.push(responseId);
      }
      record.lastUsedAt = Date.now();
    }

    if (responseId) {
      this.responseIdToThread.set(responseId, threadId);
    }

    this.entries.delete(threadId);
    this.entries.set(threadId, record);
    this.evictIfNeeded();
    this.persistSync();
  }
}
