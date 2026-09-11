import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveUpstreamHome(raw?: string): string {
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  const fromEnv = process.env.EXT_LAYER_UPSTREAM_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return join(homedir(), ".codex-chatgpt-web-upstream");
}

export function readUpstreamBiggerContext(home: string): boolean | null {
  try {
    const configPath = join(home, "config.json");
    if (!existsSync(configPath)) {
      return null;
    }
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && typeof parsed.experimentalBiggerContext === "boolean") {
      return parsed.experimentalBiggerContext;
    }
    return null;
  } catch {
    return null;
  }
}
