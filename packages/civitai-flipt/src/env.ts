// Package-owned env schema. Any app that uses @civitai/flipt reads the same vars, so a flag
// evaluates identically across apps.
import * as z from 'zod';

// Connection config is REQUIRED, but only read from env when the app didn't pass it explicitly —
// an app whose own env module already validates these (the monolith) can hand them to the factory
// instead, and then nothing here touches process.env for them.
const connectionSchema = z.object({
  FLIPT_URL: z.string(),
  FLIPT_FETCHER_SECRET: z.string(),
});

// Tuning is all-optional and never throws.
const tuningSchema = z.object({
  // Flipt "environment" (namespace-of-namespaces). The monolith lives in `civitai-app`; a spoke
  // app either shares it or declares its own.
  FLIPT_ENVIRONMENT: z.string().default('civitai-app'),
  FLIPT_DEPLOYMENT_ID: z.string().optional(),
  FLIPT_EVAL_CACHE_TTL_MS: z.string().optional(),
  FLIPT_LOCAL_OVERRIDES: z.string().optional(),
  FLIPT_SNAPSHOT_MAX_AGE_MS: z.string().optional(),
});

// parseInt is intentional (integer ms). Note a non-integer env like "0.5" parses to 0 → cache
// disabled, and "1e4" parses to 1 — both surprising, so the resolved value is reported to the
// factory's `log` for operator visibility.
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseCacheTtl(raw: string | undefined): number {
  return parseNonNegativeInt(raw, 10_000);
}

/** A seeded snapshot older than this is refused. 24h; `0` turns seeding off. */
export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Dev-only local overrides. Set FLIPT_LOCAL_OVERRIDES to short-circuit flag evaluation without
// touching shared Flipt state (GitOps overwrites it). Format: comma-separated `flagKey=variantKey`
// pairs; use `on`/`off` for booleans.
// Example: FLIPT_LOCAL_OVERRIDES=some-variant-flag=on-variant,my-bool-flag=on
export function parseLocalOverrides(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

export type FliptConnection = {
  url: string;
  clientToken: string;
};

export type FliptTuning = {
  environment: string;
  deploymentId?: string;
  /** How often the client pulls new flag config, in seconds. */
  updateIntervalSeconds: number;
  initTimeoutMs: number;
  /** Per-request timeout on every snapshot fetch, init and polls alike. */
  fetchTimeoutMs: number;
  /**
   * The oldest last-known snapshot a process that cannot reach Flipt at startup will evaluate from.
   * `0` turns seeding off. Only used when the app passes a `snapshotStore`.
   */
  snapshotMaxAgeMs: number;
  /** How often a process with live state re-saves an unchanged snapshot, so its age stays honest. */
  snapshotSaveIntervalMs: number;
  /** Bound on reading the stored snapshot, so a slow store cannot hold the first requests. */
  snapshotLoadTimeoutMs: number;
  /** After a failed init, skip re-init attempts for this long (circuit breaker). */
  failureCooldownMs: number;
  /** 0 disables the eval cache. Additive to `updateIntervalSeconds` — see README. */
  evalCacheTtlMs: number;
  evalCacheMaxEntries: number;
  localOverrides: Record<string, string>;
};

export type FliptConfig = FliptConnection & FliptTuning;

export function loadFliptTuning(): FliptTuning {
  const parsed = tuningSchema.parse(process.env);
  return {
    environment: parsed.FLIPT_ENVIRONMENT,
    deploymentId: parsed.FLIPT_DEPLOYMENT_ID,
    updateIntervalSeconds: 60,
    initTimeoutMs: 5000,
    fetchTimeoutMs: 4000,
    snapshotMaxAgeMs: parseNonNegativeInt(
      parsed.FLIPT_SNAPSHOT_MAX_AGE_MS,
      DEFAULT_SNAPSHOT_MAX_AGE_MS
    ),
    snapshotSaveIntervalMs: 10 * 60 * 1000,
    snapshotLoadTimeoutMs: 2000,
    failureCooldownMs: 30_000,
    evalCacheTtlMs: parseCacheTtl(parsed.FLIPT_EVAL_CACHE_TTL_MS),
    evalCacheMaxEntries: 10_000,
    // NODE_ENV is a universal Node convention (not Next-specific), so it's fine for a package.
    localOverrides:
      process.env.NODE_ENV === 'production'
        ? {}
        : parseLocalOverrides(parsed.FLIPT_LOCAL_OVERRIDES),
  };
}

export function loadFliptConnection(): FliptConnection {
  const parsed = connectionSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      '[@civitai/flipt] Invalid environment variables:\n' + z.prettifyError(parsed.error)
    );
  }
  return { url: parsed.data.FLIPT_URL, clientToken: parsed.data.FLIPT_FETCHER_SECRET };
}

// Lazy + memoized: importing this module does NOT touch process.env. Validation runs only when
// the factory calls loadFliptEnv() — so a bare import (build, script, test) never throws.
let _env: FliptConfig | undefined;
export function loadFliptEnv(): FliptConfig {
  return (_env ??= { ...loadFliptConnection(), ...loadFliptTuning() });
}
