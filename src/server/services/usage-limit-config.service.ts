import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import type { RateLimit } from '~/server/utils/rate-limit-window';
import {
  buildUsageLimitConfig,
  defaultUsageLimitConfig,
  getUsageLimitDef,
  resolveUsageLimitValues,
  usageLimitApplies,
  usageLimitMessage,
  USAGE_LIMITS_KEY,
  type UsageLimitConfig,
  type UsageLimitDef,
  type UsageLimitFallback,
  type UsageLimitId,
  type UsageLimitResolution,
  type UsageLimitRef,
  type UsageLimitSubject,
} from '~/shared/constants/usage-limits';

export const USAGE_LIMIT_CONFIG_TTL_MS = 60_000;
/** A cold pod waits this long for the first read, then serves the code defaults. */
export const USAGE_LIMIT_FIRST_READ_TIMEOUT_MS = 500;

// Per-pod stale-while-revalidate: past the TTL the stale config is served and one refresh runs.
let current: { config: UsageLimitConfig; loadedAt: number } | null = null;
let refreshing: Promise<UsageLimitConfig> | null = null;
let lastFallbackSignature = '';

function logFallbacks(fallbacks: UsageLimitFallback[]) {
  const signature = JSON.stringify(fallbacks);
  // Once per distinct failure set per pod, not once per refresh.
  if (signature === lastFallbackSignature) return;
  lastFallbackSignature = signature;
  if (fallbacks.length === 0) return;
  logToAxiom({
    name: 'usage-limits-defaults-firing',
    type: 'warning',
    message: 'Usage limit overrides refused; serving their code defaults',
    fallbacks,
  }).catch(() => null);
}

async function load(): Promise<UsageLimitConfig> {
  try {
    const row = await dbRead.keyValue.findUnique({ where: { key: USAGE_LIMITS_KEY } });
    const { config, fallbacks } = buildUsageLimitConfig(row?.value);
    logFallbacks(fallbacks);
    current = { config, loadedAt: Date.now() };
    return config;
  } catch (error) {
    logToAxiom({
      name: 'usage-limits-defaults-firing',
      type: 'warning',
      message: 'Usage limit config read failed; keeping the last good config',
      error: (error as Error)?.message,
      haveLastGood: !!current,
    }).catch(() => null);
    // Retry after a TTL, not on every request, while the store is down.
    current = { config: current?.config ?? defaultUsageLimitConfig, loadedAt: Date.now() };
    return current.config;
  }
}

export async function getUsageLimitConfig(): Promise<UsageLimitConfig> {
  if (current && Date.now() - current.loadedAt < USAGE_LIMIT_CONFIG_TTL_MS) return current.config;
  const refresh = (refreshing ??= load().finally(() => {
    refreshing = null;
  }));
  if (current) return current.config;
  return withTimeoutFallback(
    refresh,
    USAGE_LIMIT_FIRST_READ_TIMEOUT_MS,
    defaultUsageLimitConfig,
    () => {
      // Serve the defaults as already stale, so later callers do not each wait out the timeout.
      current ??= { config: defaultUsageLimitConfig, loadedAt: 0 };
    }
  );
}

/** Tests only: forget the cached config. */
export function resetUsageLimitConfigCache() {
  current = null;
  refreshing = null;
  lastFallbackSignature = '';
}

export type ResolvedUsageLimit = UsageLimitResolution & { def: UsageLimitDef; applies: boolean };

/** The caller's limit for `id` under the current config. */
export async function resolveUsageLimit(
  id: UsageLimitId,
  subject: UsageLimitSubject | undefined
): Promise<ResolvedUsageLimit> {
  const config = await getUsageLimitConfig();
  return resolveFrom(config, id, subject ?? {});
}

function resolveFrom(
  config: UsageLimitConfig,
  id: UsageLimitId,
  subject: UsageLimitSubject
): ResolvedUsageLimit {
  const def = getUsageLimitDef(id);
  const values = config.get(id) ?? def;
  return {
    ...resolveUsageLimitValues(values, subject),
    def,
    applies: usageLimitApplies(def, values, subject),
  };
}

/** The rate-limit rules the entries apply to this caller: one per entry that applies. */
export async function resolveUsageLimitRules(
  ids: UsageLimitRef['usageLimitIds'],
  subject: UsageLimitSubject | undefined
): Promise<RateLimit[]> {
  const config = await getUsageLimitConfig();
  const rules: RateLimit[] = [];
  for (const id of ids) {
    const resolved = resolveFrom(config, id, subject ?? {});
    const { def } = resolved;
    if (!resolved.applies || def.window.type !== 'rolling') continue;
    rules.push({
      id,
      kind: def.kind,
      limit: resolved.limit,
      period: def.window.seconds,
      errorMessage: usageLimitMessage(def, resolved),
    });
  }
  return rules;
}

/**
 * The daily post cap the post procedures apply to this caller; batch scheduling counts scheduled
 * posts against it on the day they go live, so it needs the number, not a refusal. Infinite while
 * the limit is disabled.
 */
export async function getDailyPostLimit(subject: UsageLimitSubject): Promise<number> {
  const resolved = await resolveUsageLimit('posts.daily', subject);
  return resolved.applies ? resolved.limit : Number.POSITIVE_INFINITY;
}
