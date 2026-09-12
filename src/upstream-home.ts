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

export function readUpstreamConfig(home: string | undefined): Record<string, unknown> | null {
  if (typeof home !== "string" || home.trim().length === 0) {
    return null;
  }
  try {
    const configPath = join(home.trim(), "config.json");
    if (!existsSync(configPath)) {
      return null;
    }
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function readUpstreamBiggerContext(home: string): boolean | null {
  const config = readUpstreamConfig(home);
  if (config && typeof config.experimentalBiggerContext === "boolean") {
    return config.experimentalBiggerContext;
  }
  return null;
}

export function readUpstreamControlToken(home: string): string | null {
  const config = readUpstreamConfig(home);
  if (config && typeof config.controlToken === "string" && config.controlToken.trim().length > 0) {
    return config.controlToken.trim();
  }
  return null;
}

export interface AccountCapabilities {
  solAvailable: boolean;
  proAvailable: boolean;
  source: "explicit" | "upstream-config" | "default";
}

export function resolveAccountCapabilities(
  home: string | undefined,
  explicit?: { solAvailable?: boolean; proAvailable?: boolean },
): AccountCapabilities {
  const hasExplicitSol = typeof explicit?.solAvailable === "boolean";
  const hasExplicitPro = typeof explicit?.proAvailable === "boolean";
  const hasAnyExplicit = hasExplicitSol || hasExplicitPro;

  const cfg = readUpstreamConfig(home);
  const hasCfgSol = typeof cfg?.solAvailable === "boolean";
  const hasCfgPro = typeof cfg?.proAvailable === "boolean";
  const hasAnyCfg = hasCfgSol || hasCfgPro;

  let source: "explicit" | "upstream-config" | "default";
  if (hasAnyExplicit) {
    source = "explicit";
  } else if (hasAnyCfg) {
    source = "upstream-config";
  } else {
    source = "default";
  }

  const solAvailable = hasExplicitSol
    ? explicit!.solAvailable!
    : (hasCfgSol ? (cfg!.solAvailable as boolean) : false);

  const proAvailable = hasExplicitPro
    ? explicit!.proAvailable!
    : (hasCfgPro ? (cfg!.proAvailable as boolean) : false);

  return {
    solAvailable,
    proAvailable,
    source,
  };
}

