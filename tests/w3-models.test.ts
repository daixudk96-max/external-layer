import { expect, test } from "bun:test";
import { tierSlugForEffort, unifiedCatalog } from "../src/models";

const upstreamCatalog = { models: [{ slug: "gpt-6-astra" }, { slug: "gpt-6-mini" }] };

test("a Sol account gets one unified latest row with five effort levels", () => {
  const catalog = unifiedCatalog(upstreamCatalog, { solAvailable: true, proAvailable: true });
  expect(catalog.models.map(model => model.slug)).toEqual(["chatgpt-web/latest"]);
  expect(catalog.data.map(row => row.id)).toEqual(["chatgpt-web/latest"]);
  const latest = catalog.models[0] as { default_reasoning_level?: string; supported_reasoning_levels?: Array<{ effort: string }> };
  expect(latest.default_reasoning_level).toBe("xhigh");
  expect(latest.supported_reasoning_levels?.map(level => level.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
});

test("a luna-only account keeps its historical rows", () => {
  const catalog = unifiedCatalog(upstreamCatalog, { solAvailable: false, proAvailable: false });
  const slugs = catalog.models.map(model => String(model.slug));
  expect(slugs).toContain("chatgpt-web/luna");
  expect(slugs).toContain("chatgpt-web/think");
  expect(slugs).not.toContain("chatgpt-web/latest");
});

test("effort maps to tiers with xhigh as the default", () => {
  const capabilities = { solAvailable: true, proAvailable: true };
  expect(tierSlugForEffort(undefined, capabilities)).toBe("chatgpt-web/extra-high");
  expect(tierSlugForEffort("low", capabilities)).toBe("chatgpt-web/light");
  expect(tierSlugForEffort("medium", capabilities)).toBe("chatgpt-web/medium");
  expect(tierSlugForEffort("high", capabilities)).toBe("chatgpt-web/high");
  expect(tierSlugForEffort("xhigh", capabilities)).toBe("chatgpt-web/extra-high");
  expect(tierSlugForEffort("max", capabilities)).toBe("chatgpt-web/pro");
  expect(tierSlugForEffort("nonsense", capabilities)).toBe("chatgpt-web/extra-high");
});
