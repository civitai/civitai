import { semanticGuardStatusReads } from '~/server/metrics/semantic-search.metrics';
import { searchServiceAuth, searchServiceUrl } from '~/server/services/semantic-search-client';

const OK_TTL_MS = 30_000;
// Shorter, so a blip turns the candidate cache off for seconds rather than a full window.
const FAILED_TTL_MS = 5_000;
const STATUS_TIMEOUT_MS = 2_000;
const MODES = new Set(['off', 'shadow', 'enforce']);

export type GuardStatus = {
  /** Mode and artifact version; `unknown` when unreadable, which no cached block is keyed on. */
  key: string;
  /** Rules whose audit rows keep no result ids; `null` (every rule withholds) when unreadable, not
   * sent or empty: an empty list from a healthy service is read as misconfigured, not as "none". */
  withholdResults: ReadonlySet<string> | null;
};

export const UNKNOWN_GUARD_STATUS: GuardStatus = { key: 'unknown', withholdResults: null };

/**
 * No artifact (`null`) keys as the bare mode: every real version, `none` or `''` included, carries
 * the `:`, so a block cached before an artifact ships is never served under one.
 */
export function guardKey(mode: string, version: string | null) {
  return version === null ? mode : `${mode}:${version}`;
}

export function parseGuardStatus(raw: unknown): GuardStatus {
  if (!raw || typeof raw !== 'object') return UNKNOWN_GUARD_STATUS;
  const { mode, version, withhold_results } = raw as Record<string, unknown>;
  if (typeof mode !== 'string' || !MODES.has(mode)) return UNKNOWN_GUARD_STATUS;
  if (version !== null && typeof version !== 'string') return UNKNOWN_GUARD_STATUS;
  const withheld = Array.isArray(withhold_results)
    ? withhold_results.filter((r): r is string => typeof r === 'string')
    : [];
  return {
    key: guardKey(mode, version as string | null),
    withholdResults: withheld.length ? new Set(withheld) : null,
  };
}

/** Memoised per process and single-flight: one status read per window, however many searches. */
export function createGuardStatusReader(
  fetchStatus: () => Promise<unknown>,
  now: () => number = Date.now
): () => Promise<GuardStatus> {
  let cached: { status: GuardStatus; expiresAt: number } | undefined;
  let inflight: Promise<GuardStatus> | undefined;
  return () => {
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.status);
    inflight ??= fetchStatus()
      .then(parseGuardStatus, () => UNKNOWN_GUARD_STATUS)
      .then((status) => {
        const ok = status !== UNKNOWN_GUARD_STATUS;
        semanticGuardStatusReads().inc({ outcome: ok ? 'ok' : 'unknown' });
        cached = { status, expiresAt: now() + (ok ? OK_TTL_MS : FAILED_TTL_MS) };
        return status;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

export const readGuardStatus = createGuardStatusReader(async () => {
  const res = await fetch(searchServiceUrl('/v1/guard/status'), {
    headers: searchServiceAuth(),
    signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`guard status ${res.status}`);
  return res.json();
});
