// Known-approved AppBlock id set — a cheap, in-memory, TTL-cached lookup used to
// BOUND the `app_block_id` prom label on the PUBLIC, unauthenticated
// /api/track/block-render beacon (see src/pages/api/track/block-render.ts).
//
// WHY: that beacon takes `appBlockId` straight from a same-origin CLIENT body
// (validated only for length). It has NO runtime-flag gate and NO rate limit, so
// a scripted client could post unlimited DISTINCT ids — and prom-client retains
// every distinct label set in the Node heap forever → unbounded heap growth (the
// known --max-old-space-size exit-139 OOM class). Clamping unknown ids to 'other'
// bounds the label to the real approved-app set (dozens today) while preserving
// per-app render-failure attribution for approved apps.
//
// Mirrors the single-flight + TTL cache posture of `loadAllowedOrigins` in
// block-scope.middleware.ts: at most one DB query per TTL window per pod, never a
// per-request hit. Fails SAFE — on a cold cache or DB error the set is treated as
// empty, so every id buckets to 'other' (bounded) rather than passing through.
const KNOWN_APP_BLOCKS_TTL_MS = 5 * 60_000; // 5min — approved set changes rarely

/**
 * A resolved view of the approved-id set.
 *
 * 🔴 `trusted` RECORDS WHETHER THE QUERY BEHIND `ids` SUCCEEDED, and it exists
 * because the fail-safe posture above is only safe for the thing it was written
 * for. Clamping a prom label wants "assume unknown" — an empty set buckets
 * everything to 'other', which is bounded. But an empty set also makes EVERY id
 * look non-approved, so any consumer that reads "not in the set" as a FACT about
 * the app is reading a database outage as a universal claim. Consumers that care
 * must ask for `isConfirmedNonApprovedAppBlockId`, which answers `false` here.
 */
type ApprovedSet = { ids: Set<string>; trusted: boolean };
type CacheEntry = ApprovedSet & { expiresAt: number };
let _cache: CacheEntry | null = null;
let _inflight: Promise<ApprovedSet> | null = null;

async function loadKnownAppBlockIds(): Promise<ApprovedSet> {
  const ids = new Set<string>();
  try {
    // Dynamic import so this module doesn't eager-load the Prisma client into
    // the lightweight beacon route's import graph (mirrors the middleware's
    // dynamic dbRead import).
    const { dbRead } = await import('~/server/db/client');
    const rows = (await dbRead.appBlock.findMany({
      where: { status: 'approved' },
      select: { id: true },
    })) as Array<{ id: string }>;
    for (const row of rows) ids.add(row.id);
  } catch (err) {
    // DB unreachable → return whatever we have (empty). Everything then buckets
    // to 'other' — bounded and safe. Log once per refresh so ops can see it.
    // eslint-disable-next-line no-console
    console.warn(
      `[known-app-blocks] approved AppBlock lookup failed; treating known set as empty: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    // NOT trusted: the set is empty because we could not ask, not because there
    // are no approved apps.
    return { ids, trusted: false };
  }
  return { ids, trusted: true };
}

async function getKnownAppBlockIds(): Promise<ApprovedSet> {
  const now = Date.now();
  const cached = _cache;
  // A failed load is cached for the same TTL as a good one — unchanged, and
  // deliberate: it is what keeps a database outage from re-querying per request.
  // `trusted` rides along in the entry so the untrusted window is visible to
  // consumers for exactly as long as it lasts.
  if (cached && cached.expiresAt > now) return cached;
  // Single-flight: coalesce concurrent cold-start refreshes into one query.
  if (_inflight) return _inflight;
  _inflight = loadKnownAppBlockIds()
    .then((set) => {
      _cache = { ...set, expiresAt: Date.now() + KNOWN_APP_BLOCKS_TTL_MS };
      return set;
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}

/**
 * True iff `appBlockId` is a currently-approved AppBlock (from the TTL-cached
 * set). Used to clamp the render-beacon's `app_block_id` prom label. Fails safe
 * to false (→ 'other') on a cold cache / DB error.
 */
export async function isKnownAppBlockId(appBlockId: string): Promise<boolean> {
  const { ids } = await getKnownAppBlockIds();
  return ids.has(appBlockId);
}

/**
 * True iff `appBlockId` is CONFIRMED to be outside the approved set — the query
 * behind the cache succeeded and the id was not in it.
 *
 * 🔴 THIS IS NOT `!isKnownAppBlockId(id)`, AND THE DIFFERENCE IS THE WHOLE POINT.
 * That negation answers `true` for every id in the world whenever the approved
 * lookup fails, because the failure path caches an EMPTY set (see `ApprovedSet`).
 * A consumer using it as a cheap pre-filter before expensive work would therefore
 * escalate every request during a database outage — adding load to the failing
 * database, on whatever path it sits on. This form answers `false` while the set
 * is untrusted, so "I could not ask" never reads as "the app is not approved".
 *
 * Used by `private-run-impression.service` to decide, for free, that an
 * impression on a live approved app cannot be a private run. It is a COST filter
 * there: the authoritative status check is `resolvePrivateRunAccess`, which
 * refuses an approved app outright, so a wrong answer here changes load, not
 * behaviour.
 *
 * 🔴 THAT LAST SENTENCE IS A PRECONDITION ON THE CALLER, NOT A PROPERTY OF THIS
 * FUNCTION. It holds only because the one existing consumer re-checks status
 * authoritatively downstream. A consumer that treats this answer as the DECISION
 * turns it into a correctness gate, and then the `trusted` semantics read the
 * other way round: during an approved-lookup outage this answers `false` for
 * every id, which such a consumer would read as "every app is approved". If you
 * are adding the second caller, say which of the two you are.
 *
 * ⚠️ And one edge that is not a defect but is worth knowing: a SUCCESSFUL query
 * returning zero rows yields `trusted: true` with an empty set, so every id is
 * "confirmed non-approved". Real only in an environment with no approved apps.
 */
export async function isConfirmedNonApprovedAppBlockId(appBlockId: string): Promise<boolean> {
  const { ids, trusted } = await getKnownAppBlockIds();
  return trusted && !ids.has(appBlockId);
}

/**
 * Clamp a client-supplied appBlockId to a bounded prom label: the id itself when
 * it's an approved app, else 'other'. Keeps the `app_block_id` cardinality
 * bounded to the real approved set regardless of client input.
 */
export async function boundAppBlockIdLabel(appBlockId: string): Promise<string> {
  return (await isKnownAppBlockId(appBlockId)) ? appBlockId : 'other';
}

/** Test-only: clear the in-memory cache so a unit test can swap the DB mock. */
export const _internalsForTests = {
  reset(): void {
    _cache = null;
    _inflight = null;
  },
};
