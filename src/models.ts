/**
 * W3 model layer — the unified `chatgpt-web/latest` catalog and the
 * `reasoning_effort` → tier-slug map.
 *
 * Unified tiering mirrors the upstream provider (`src/server.ts` in codex-chatgpt-web):
 *
 *  - A Sol/Pro account sees exactly ONE advertised model id, `chatgpt-web/latest`. The tier is
 *    chosen per request through `reasoning_effort`. The row therefore advertises the whole tier
 *    ladder in `supported_reasoning_levels` and pins `default_reasoning_level` to Extra High
 *    (`xhigh`); `max` is the ChatGPT Pro tier — a fundamentally different root model upstream —
 *    and is never the silent default.
 *  - A Luna-only account (`solAvailable === false`) keeps its historical `chatgpt-web/luna` /
 *    `chatgpt-web/think` rows and never sees `chatgpt-web/latest`; such accounts have no effort
 *    ladder at all.
 *  - Row metadata (context windows, service tiers, whatever the upstream catalog carries) is
 *    inherited from the live upstream catalog instead of being hardcoded here, so an upstream
 *    model change (or a context-window change) propagates without touching this module.
 *
 * The returned `data[]` follows the standard OpenAI "list models" shape so any standard client
 * (`data[].id`) works; the richer internal rows stay additively in `models[]`.
 */

type JsonObject = Record<string, unknown>;

export interface ModelCapabilities {
  /** The account can select the ChatGPT Web Sol family (and therefore the unified `latest` id). */
  solAvailable: boolean;
  /** The account can select the Pro tier (`reasoning_effort: "max"`). */
  proAvailable: boolean;
}

export interface UnifiedCatalog {
  object: "list";
  data: Array<{ id: string; object: "model" }>;
  models: Array<Record<string, unknown>>;
}

export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
export const CHATGPT_WEB_LATEST_MODEL_ID = "chatgpt-web/latest";
export const CHATGPT_WEB_DEFAULT_TIER_EFFORT = "xhigh";
export const CHATGPT_WEB_LUNA_MODEL_ID = "chatgpt-web/luna";
export const CHATGPT_WEB_THINK_MODEL_ID = "chatgpt-web/think";

interface UnifiedTier {
  /** `reasoning_effort` value accepted from a standard Responses client. */
  effort: string;
  /** Legacy per-tier slug this effort routes to inside the upstream provider. */
  slug: string;
  /** Catalog label mirroring the ChatGPT web tier selector. */
  displayName: string;
  /** `requiresPro` tiers disappear from the catalog for accounts without Pro. */
  requiresPro: boolean;
}

/**
 * The five-tier ladder, in web-selector order. `xhigh` (Extra High) is the default; `max` (Pro)
 * rides a different root model upstream, so it is Pro-gated and never advertised as the default.
 */
export const CHATGPT_WEB_UNIFIED_TIERS: readonly UnifiedTier[] = [
  { effort: "low", slug: "chatgpt-web/light", displayName: "ChatGPT Web — Light", requiresPro: false },
  { effort: "medium", slug: "chatgpt-web/medium", displayName: "ChatGPT Web — Medium", requiresPro: false },
  { effort: "high", slug: "chatgpt-web/high", displayName: "ChatGPT Web — High", requiresPro: false },
  { effort: "xhigh", slug: "chatgpt-web/extra-high", displayName: "ChatGPT Web — Extra High", requiresPro: false },
  { effort: "max", slug: "chatgpt-web/pro", displayName: "ChatGPT Web — Pro", requiresPro: true },
];

const UNIFIED_DESCRIPTION =
  "Unified ChatGPT Web model. Pick the tier via reasoning_effort: low=Light, medium=Medium, "
  + "high=High, xhigh=Extra High (default), max=Pro.";

/** Legacy aliases accepted on the request path (upstream maps `minimal` onto the Light tier). */
const EFFORT_ALIASES: Record<string, string> = {
  minimal: "low",
};

/** Supported `reasoning_effort` values in ladder order — shared by the catalog and error messages. */
export const CHATGPT_WEB_EFFORT_LADDER: readonly string[] = CHATGPT_WEB_UNIFIED_TIERS.map(tier => tier.effort);

/**
 * Raised for an effort outside the ladder. Serving the default tier instead would answer with a
 * different model than the caller asked for, so the facade turns this into HTTP 400.
 */
export class UnknownEffortError extends Error {
  constructor(effort: string) {
    super(
      `unknown reasoning effort "${effort}" for ${CHATGPT_WEB_LATEST_MODEL_ID}; supported values: `
      + `${CHATGPT_WEB_EFFORT_LADDER.join(", ")}`,
    );
    this.name = "UnknownEffortError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** JSON-shaped deep copy: upstream catalogs are parsed JSON, and this keeps zero dependencies. */
function copyJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => copyJson(entry));
  if (isObject(value)) {
    const copy: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = copyJson(entry);
    return copy;
  }
  return value;
}

function rowSlug(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  return typeof value.slug === "string" ? value.slug : undefined;
}

/**
 * The upstream catalog is `unknown`: accept `{ models: [...] }` (Codex shape) or `{ data: [...] }`
 * (OpenAI shape) and never throw on a malformed payload — a degraded upstream catalog must not
 * take the façade's model listing down.
 */
function upstreamRows(catalog: unknown): JsonObject[] {
  if (!isObject(catalog)) return [];
  const rows = Array.isArray(catalog.models)
    ? catalog.models
    : (Array.isArray(catalog.data) ? catalog.data : []);
  return rows.filter(isObject);
}

/**
 * Pick the upstream row whose metadata seeds every advertised row. Native (non `chatgpt-web/`)
 * rows win so a stale `chatgpt-web/*` row from an earlier catalog can never seed the ladder.
 * OpenAI-shaped aliases are dropped: every advertised row re-derives them from its own slug.
 */
function modelTemplate(catalog: unknown): JsonObject {
  const rows = upstreamRows(catalog);
  const native = rows.find(row => {
    const slug = rowSlug(row);
    return slug !== undefined && !slug.startsWith(CHATGPT_WEB_MODEL_PREFIX);
  });
  const source = native ?? rows[0];
  if (!source) return {};
  const template = copyJson(source) as JsonObject;
  for (const alias of ["id", "object", "created", "owned_by"]) delete template[alias];
  return template;
}

/** Reuse the upstream reasoning-level metadata for a tier when the template carries it. */
function reasoningLevel(template: JsonObject, effort: string, description: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels) ? template.supported_reasoning_levels : [];
  const source = levels.find(level => isObject(level) && level.effort === effort);
  return { ...(isObject(source) ? copyJson(source) as JsonObject : {}), effort, description };
}

/** Shared row surface for every advertised ChatGPT Web row. */
function webRow(template: JsonObject): JsonObject {
  return {
    ...copyJson(template) as JsonObject,
    visibility: "list",
    // These slugs are implemented by this local Responses-compatible façade.
    supported_in_api: true,
    input_modalities: ["text", "image"],
    tool_mode: null,
    upgrade: null,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
}

/** The single unified row: tiers ride on reasoning_effort, Extra High is the default. */
function latestRow(template: JsonObject, capabilities: ModelCapabilities): JsonObject {
  const tiers = CHATGPT_WEB_UNIFIED_TIERS.filter(tier => !tier.requiresPro || capabilities.proAvailable);
  return {
    ...webRow(template),
    slug: CHATGPT_WEB_LATEST_MODEL_ID,
    display_name: "ChatGPT Web — Latest",
    description: UNIFIED_DESCRIPTION,
    multi_agent_version: "v1",
    default_reasoning_level: CHATGPT_WEB_DEFAULT_TIER_EFFORT,
    supported_reasoning_levels: tiers.map(tier => reasoningLevel(template, tier.effort, tier.displayName)),
  };
}

/**
 * Historical Luna-only rows. Both advertise the upstream Luna protocol effort (`low`); Think is
 * distinguished by its slug and by the adapter's internal effort, following the upstream routes.
 */
function lunaRow(template: JsonObject, slug: string, displayName: string, description: string): JsonObject {
  return {
    ...webRow(template),
    slug,
    display_name: displayName,
    description,
    default_reasoning_level: "low",
    supported_reasoning_levels: [reasoningLevel(template, "low", displayName)],
  };
}

/**
 * Build the advertised model catalog for an account.
 *
 * Sol accounts collapse the whole upstream catalog into the single `chatgpt-web/latest` row;
 * Luna-only accounts keep their two historical rows. Tier count is capability-filtered: a tier
 * the account cannot select (Pro/`max`) is never advertised. `data[].id` carries the slug so
 * standard OpenAI clients keep working unchanged.
 */
export function unifiedCatalog(upstreamCatalog: unknown, capabilities: ModelCapabilities): UnifiedCatalog {
  const template = modelTemplate(upstreamCatalog);
  const models = capabilities.solAvailable
    ? [latestRow(template, capabilities)]
    : [
      lunaRow(
        template,
        CHATGPT_WEB_LUNA_MODEL_ID,
        "ChatGPT Web — Luna",
        "ChatGPT Web Luna for accounts without the Sol model selector.",
      ),
      lunaRow(
        template,
        CHATGPT_WEB_THINK_MODEL_ID,
        "ChatGPT Web — Think",
        "ChatGPT Web Think for Luna-only accounts.",
      ),
    ];
  return {
    object: "list",
    data: models.map(model => ({ id: String(model.slug), object: "model" as const })),
    models,
  };
}

function defaultTier(): UnifiedTier {
  const tier = CHATGPT_WEB_UNIFIED_TIERS.find(candidate => candidate.effort === CHATGPT_WEB_DEFAULT_TIER_EFFORT);
  if (!tier) throw new Error(`Unified tier ladder is missing the ${CHATGPT_WEB_DEFAULT_TIER_EFFORT} default`);
  return tier;
}

function normalizeEffort(effort: string | undefined): string | undefined {
  if (typeof effort !== "string") return undefined;
  const normalized = effort.trim().toLowerCase();
  if (!normalized) return undefined;
  return EFFORT_ALIASES[normalized] ?? normalized;
}

/**
 * Map a request's `reasoning_effort` onto the upstream tier slug.
 *
 * Unknown or missing efforts fall back to Extra High (the unified default), and `max` (the Pro
 * tier, a fundamentally different root model) clamps to Extra High on accounts without Pro rather
 * than routing to a tier the account cannot select. The mapping itself stays total: it is the
 * request path's job to reject models the catalog never advertised.
 */
export function tierSlugForEffort(effort: string | undefined, capabilities: ModelCapabilities): string {
  const normalized = normalizeEffort(effort);
  const tier = normalized === undefined
    ? defaultTier()
    : CHATGPT_WEB_UNIFIED_TIERS.find(candidate => candidate.effort === normalized);
  // Silently downgrading an unrecognised effort would serve a different tier than the client
  // asked for (e.g. a typo'd "max" answering with Extra High) - fail loud instead.
  if (!tier) throw new UnknownEffortError(normalized as string);
  if (tier.requiresPro && !capabilities.proAvailable) return defaultTier().slug;
  return tier.slug;
}
