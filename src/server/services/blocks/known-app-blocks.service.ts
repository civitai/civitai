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

type CacheEntry = { ids: Set<string>; expiresAt: number };
let _cache: CacheEntry | null = null;
let _inflight: Promise<Set<string>> | null = null;

async function loadKnownAppBlockIds(): Promise<Set<string>> {
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
  }
  return ids;
}

async function getKnownAppBlockIds(): Promise<Set<string>> {
  const now = Date.now();
  const cached = _cache;
  if (cached && cached.expiresAt > now) return cached.ids;
  // Single-flight: coalesce concurrent cold-start refreshes into one query.
  if (_inflight) return _inflight;
  _inflight = loadKnownAppBlockIds()
    .then((ids) => {
      _cache = { ids, expiresAt: Date.now() + KNOWN_APP_BLOCKS_TTL_MS };
      return ids;
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
  const ids = await getKnownAppBlockIds();
  return ids.has(appBlockId);
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
