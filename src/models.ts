import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { DevinCredentials } from "./credentials.js";
import { runDevin } from "./cli.js";
import { buildMetadata } from "./metadata.js";
import { encodeMessage, iterFields } from "./wire.js";

export interface DevinVariant {
  model_uid: string;
  label: string;
  max_context_tokens?: number;
  max_output_tokens?: number;
  cost_tier?: string;
  cost_summary?: string;
  is_new?: boolean;
  is_beta?: boolean;
}

export interface DevinFamily {
  family_label: string;
  family_uid: string;
  slug: string;
  aliases?: string[];
  variants: DevinVariant[];
}

export interface DevinCatalog {
  families: DevinFamily[];
}

const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function parseCost(summary?: string): ProviderModelConfig["cost"] {
  const empty = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!summary) return empty;
  const input = summary.match(/\$([0-9.]+)\s*\/\s*(?:MTok|1M)\s*In/i);
  const output = summary.match(/\$([0-9.]+)\s*\/\s*(?:MTok|1M)\s*Out/i);
  const cached = summary.match(/\$([0-9.]+)\s*\/\s*(?:MTok|1M)\s*Cached/i);
  const inCost = input ? Number(input[1]) : 0;
  const outCost = output ? Number(output[1]) : 0;
  return {
    input: inCost,
    output: outCost,
    cacheRead: cached ? Number(cached[1]) : Number((inCost * 0.1).toFixed(4)),
    cacheWrite: Number((inCost * 1.25).toFixed(4)),
  };
}

function variantKey(uid: string): string | null {
  const suffixes = [
    "none-priority",
    "low-priority",
    "medium-priority",
    "high-priority",
    "xhigh-priority",
    "max-priority",
    "low-fast",
    "medium-fast",
    "high-fast",
    "xhigh-fast",
    "max-fast",
    "thinking-1m",
    "thinking",
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "minimal",
  ];
  for (const suffix of suffixes) {
    if (uid === suffix || uid.endsWith(`-${suffix}`)) return suffix;
  }
  return null;
}

function thinkingFromSuffix(suffix: string | null): keyof ThinkingLevelMap | null {
  if (!suffix) return "high";
  if (suffix === "none" || suffix === "none-priority") return "off";
  if (suffix === "minimal") return "minimal";
  if (suffix.startsWith("low")) return "low";
  if (suffix.startsWith("medium")) return "medium";
  if (suffix.startsWith("high") && !suffix.startsWith("xhigh")) return "high";
  if (suffix.startsWith("xhigh")) return "xhigh";
  if (suffix.startsWith("max")) return "max";
  if (suffix.includes("thinking")) return "high";
  return null;
}

function preferredDefault(map: ThinkingLevelMap): string | undefined {
  for (const level of ["high", "medium", "max", "xhigh", "low", "minimal", "off"] as const) {
    const value = map[level];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function familyToModels(family: DevinFamily): ProviderModelConfig[] {
  const usable = family.variants.filter((variant) => {
    const key = variantKey(variant.model_uid);
    return !key || (!key.includes("priority") && !key.includes("fast") && key !== "thinking-1m");
  });
  const source = usable.length > 0 ? usable : family.variants;
  const thinkingLevelMap: ThinkingLevelMap = {};
  for (const variant of source) {
    const level = thinkingFromSuffix(variantKey(variant.model_uid));
    if (level && thinkingLevelMap[level] === undefined) {
      thinkingLevelMap[level] = variant.model_uid;
    }
  }
  // pi treats a missing level as supported and only null hides it, so mark every
  // level this family does not ship. The picker then matches the real variants
  // instead of silently falling back to the default one.
  for (const level of THINKING_ORDER) {
    if (thinkingLevelMap[level] === undefined) thinkingLevelMap[level] = null;
  }

  const defaultUid = preferredDefault(thinkingLevelMap) ?? source[0]?.model_uid ?? family.family_uid;
  const sample = source.find((variant) => variant.model_uid === defaultUid) ?? source[0];
  if (!sample) return [];

  const mappedLevels = THINKING_ORDER.filter((level) => typeof thinkingLevelMap[level] === "string");
  const reasoning = mappedLevels.length > 1;

  // With a thinking map the pi-facing id never reaches the wire — resolveModelUid
  // always maps it — so keep the family id and let pi's thinking level choose the
  // variant, instead of baking "-high" into the model id.
  const familyId = family.slug || family.family_uid || defaultUid;

  return [
    {
      id: reasoning ? familyId : defaultUid,
      name: family.family_label || family.slug || defaultUid,
      reasoning,
      thinkingLevelMap: reasoning ? thinkingLevelMap : undefined,
      input: ["text", "image"],
      cost: parseCost(sample.cost_summary),
      contextWindow: sample.max_context_tokens ?? 256_000,
      maxTokens: sample.max_output_tokens ?? 128_000,
    },
  ];
}

export const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "claude-opus-5-low",
      medium: "claude-opus-5-medium",
      high: "claude-opus-5-high",
      xhigh: "claude-opus-5-xhigh",
      max: "claude-opus-5-max",
    },
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "claude-5-fable-low",
      medium: "claude-5-fable-medium",
      high: "claude-5-fable-high",
      xhigh: "claude-5-fable-xhigh",
      max: "claude-5-fable-max",
    },
    input: ["text", "image"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    reasoning: true,
    thinkingLevelMap: {
      off: "gpt-5-6-sol-none",
      minimal: null,
      low: "gpt-5-6-sol-low",
      medium: "gpt-5-6-sol-medium",
      high: "gpt-5-6-sol-high",
      xhigh: "gpt-5-6-sol-xhigh",
      max: "gpt-5-6-sol-max",
    },
    input: ["text", "image"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: "swe-2",
    name: "SWE-2",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: "swe-2-medium",
      high: "swe-2-high",
      xhigh: null,
      max: "swe-2-max",
    },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_000,
    maxTokens: 128_000,
  },
  {
    id: "swe-1.7",
    name: "SWE-1.7",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: null,
      medium: "swe-1-7-medium",
      high: "swe-1-7",
      xhigh: null,
      max: null,
    },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_000,
    maxTokens: 128_000,
  },
];

export function modelsFromCatalog(catalog: DevinCatalog | null): ProviderModelConfig[] {
  if (!catalog?.families?.length) return FALLBACK_MODELS;
  const models = catalog.families.flatMap(familyToModels);
  return models.length > 0 ? models : FALLBACK_MODELS;
}

export async function loadCliCatalog(): Promise<DevinCatalog | null> {
  const { stdout, code, stderr } = await runDevin(["models", "list", "--format", "json"], {
    timeoutMs: 20_000,
  });
  if (code !== 0) {
    throw new Error(stderr.trim() || `devin models list exited ${code}`);
  }
  const parsed = JSON.parse(stdout) as DevinCatalog;
  if (!parsed?.families) return null;
  return parsed;
}

/**
 * Direct Connect call to ApiServerService/GetCliModelConfigs — the same RPC
 * `devin models list` uses. The server gates the full catalog by client ide:
 * "windsurf" returns every model, while "devin-desktop" (our stream identity)
 * gets a one-entry list. No user JWT needed; the api key in Metadata suffices.
 */
const CATALOG_IDE = "windsurf";

function slugFromLabel(label: string): string {
  // Claude Fable 5 -> claude-fable-5, GPT-4.1 -> gpt-4.1
  return label.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
}

function costSummary(prices: Map<string, number>): string | undefined {
  if (!prices.size) return undefined;
  // Rust {:.2} rounds half-to-even on the exact float; mirror that so the
  // cached-price cents (0.125, 0.175, …) print like the CLI.
  const fmt = (n: number) => {
    const cents = n * 100;
    const lo = Math.floor(cents);
    const tie = cents - lo === 0.5;
    const r = tie ? (lo % 2 === 0 ? lo : lo + 1) : Math.round(cents);
    return String(r / 100);
  };
  return [...prices.entries()].map(([label, n]) => `$${fmt(n)} / 1M ${label}`).join(" · ");
}

/** Parse one ClientModelConfig (repeated field 1) into a DevinVariant + family key. */
function parseClientModelConfig(
  msg: Buffer,
): { familyKey: string; familyLabel: string; variant: DevinVariant } | null {
  let label = "";
  let modelUid = "";
  let familyUid = "";
  let familyLabel = "";
  let maxCtx = 0;
  let maxOut = 0;
  let isNew = false;
  let isBeta = false;
  const prices = new Map<string, number>();

  for (const f of iterFields(msg)) {
    if (f.num === 1 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      label = f.value.toString("utf8");
    } else if (f.num === 9 && f.wire === 0) {
      isBeta = f.value === 1n;
    } else if (f.num === 15 && f.wire === 0) {
      isNew = f.value === 1n;
    } else if (f.num === 18 && f.wire === 0) {
      maxCtx = Number(f.value);
    } else if (f.num === 22 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      modelUid = f.value.toString("utf8");
    } else if (f.num === 23 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // model_info: 4 = context tokens, 13 = output tokens, 23 = family uid
      for (const sf of iterFields(f.value)) {
        if (sf.num === 4 && sf.wire === 0) maxCtx = maxCtx || Number(sf.value);
        else if (sf.num === 13 && sf.wire === 0) maxOut = Number(sf.value);
        else if (sf.num === 23 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
          familyUid = sf.value.toString("utf8");
        }
      }
    } else if (f.num === 30 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // model_family_metadata: 1 = family label
      for (const sf of iterFields(f.value)) {
        if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
          familyLabel = sf.value.toString("utf8");
        }
      }
    } else if (f.num === 32 && f.wire === 2 && Buffer.isBuffer(f.value)) {
      // pricing entry: 1 = label ("Input"/"Cached input"/"Output"), 2 = $/1M float32
      let priceLabel = "";
      let price = 0;
      for (const sf of iterFields(f.value)) {
        if (sf.num === 1 && sf.wire === 2 && Buffer.isBuffer(sf.value)) {
          priceLabel = sf.value.toString("utf8");
        } else if (sf.num === 2 && sf.wire === 5 && Buffer.isBuffer(sf.value)) {
          price = sf.value.readFloatLE(0);
        }
      }
      if (priceLabel) prices.set(priceLabel, price);
    }
  }

  // Models without a family (MODEL_* enum uids, routers) group by label,
  // like the CLI does: family_uid = label, slug = slugified label.
  if (!modelUid || (!familyUid && !label)) return null;
  return {
    familyKey: familyUid || label,
    familyLabel: familyLabel || label || familyUid,
    variant: {
      model_uid: modelUid,
      label: label || modelUid,
      max_context_tokens: maxCtx || undefined,
      max_output_tokens: maxOut || undefined,
      cost_summary: costSummary(prices),
      is_new: isNew || undefined,
      is_beta: isBeta || undefined,
    },
  };
}

export async function loadHttpCatalog(
  apiKey: string,
  host: string,
): Promise<DevinCatalog | null> {
  const metadata = buildMetadata({
    apiKey,
    sessionId: randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: randomUUID(),
    ide: CATALOG_IDE,
  });
  const resp = await fetch(
    `${host.replace(/\/$/, "")}/exa.api_server_pb.ApiServerService/GetCliModelConfigs`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/proto",
        "Connect-Protocol-Version": "1",
      },
      body: new Uint8Array(encodeMessage(1, metadata)),
      signal: AbortSignal.timeout(15_000),
    },
  );
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!resp.ok) {
    throw new Error(`GetCliModelConfigs HTTP ${resp.status}: ${buf.toString("utf8").slice(0, 240)}`);
  }

  const families = new Map<string, DevinFamily>();
  for (const f of iterFields(buf)) {
    if (f.num !== 1 || f.wire !== 2 || !Buffer.isBuffer(f.value)) continue;
    const parsed = parseClientModelConfig(f.value);
    if (!parsed) continue;
    let family = families.get(parsed.familyKey);
    if (!family) {
      family = {
        family_label: parsed.familyLabel,
        family_uid: parsed.familyKey,
        slug: slugFromLabel(parsed.familyLabel),
        variants: [],
      };
      families.set(parsed.familyKey, family);
    }
    family.variants.push(parsed.variant);
  }
  return families.size > 0 ? { families: [...families.values()] } : null;
}

/**
 * Catalog over HTTP first (no CLI spawn); falls back to `devin models list`
 * when there are no stored credentials or the HTTP call fails.
 */
export async function loadCatalog(creds: DevinCredentials | null): Promise<DevinCatalog | null> {
  if (creds?.apiKey) {
    try {
      const catalog = await loadHttpCatalog(creds.apiKey, creds.apiServerUrl);
      if (catalog?.families.length) return catalog;
    } catch {
      // fall through to the CLI path
    }
  }
  return loadCliCatalog();
}

export function resolveModelUid(
  modelId: string,
  thinkingLevelMap: ThinkingLevelMap | undefined,
  reasoning?: string,
): string {
  if (reasoning && thinkingLevelMap) {
    const mapped = thinkingLevelMap[reasoning as keyof ThinkingLevelMap];
    if (typeof mapped === "string") return mapped;
  }
  if (thinkingLevelMap) {
    const fallback = preferredDefault(thinkingLevelMap);
    if (fallback) return fallback;
  }
  return modelId;
}
