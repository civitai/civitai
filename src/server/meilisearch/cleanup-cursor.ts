import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * Cross-run scan cursor for the nightly search-index cleanup.
 *
 * The scan walks an index by keyset (`id > cursor`) and, on a multi-million-document
 * index, cannot always finish inside one nightly run. Without persistence every run
 * restarts at the bottom, so a pass that is repeatedly truncated re-walks the same
 * already-clean low-id prefix every night and NEVER reaches the region past its
 * stopping point — cumulative progress is exactly zero no matter how large the page
 * size is. This module is the state that makes the next run continue instead.
 *
 * Storage is `sysRedis`, the same client the job's own lock already uses, in one hash
 * keyed by cleanup index. It is durable across pod rolls, needs no schema change, and
 * losing it is harmless: a missing cursor means "start from the bottom", which is the
 * pre-existing behaviour.
 */

export type ScanCursor = {
  /** Highest id already walked past in this pass. The next page asks for `id > lastId`. */
  lastId: number;
  /** When the pass this cursor belongs to first started, epoch ms. Bounds its staleness. */
  startedAt: number;
  /**
   * Ids walked past across EVERY run of this pass so far (judged + skipped). A resumed
   * run scans only the remainder, so this — not the run's own count — is what a
   * coverage verdict about the pass has to be computed from.
   */
  covered: number;
};

/**
 * How long one pass may be carried across runs before the next run is forced back to
 * the bottom of the index regardless of where it stopped.
 *
 * Seven days, because the job is nightly: an index that truncates every single night
 * gets at most seven consecutive resumes to finish a full sweep, and the largest index
 * covered ~1.8M of ~11.6M documents in the run that exposed this, so seven runs is
 * enough to complete one pass at the observed rate. The bound is what stops a
 * persistently-truncating index from drifting into never re-examining early ids: past
 * it, a document that went stale near the bottom of the id space would wait for the
 * cursor to lap the whole index, which could be indefinitely.
 */
export const MAX_CURSOR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Why a stored cursor was not used. Reported so a run that silently restarted from the
 * bottom is distinguishable from one that had nothing stored — the two look identical
 * in the scan itself and have completely different causes.
 */
export type CursorDiscardReason =
  | 'none' // used
  | 'missing' // nothing stored
  | 'unreadable' // the store could not be read
  | 'unparseable' // stored, but not JSON
  | 'invalid' // parsed, but not a cursor record
  | 'stale'; // older than MAX_CURSOR_AGE_MS (or dated in the future)

export type ReadCursorResult = { cursor: ScanCursor | null; reason: CursorDiscardReason };

const FIELD = (key: string) => key;

/**
 * Every rejection here resolves to `{ cursor: null }` — start from the beginning.
 *
 * 🔴 That direction is the whole safety argument. Restarting re-examines documents that
 * were already examined, which costs time; skipping ahead on a value we could not
 * validate would leave a region of the index unexamined with nothing to indicate it.
 * A cursor is only ever trusted when it parses to a whole record whose age we can bound.
 */
export async function readScanCursor(key: string, now = Date.now()): Promise<ReadCursorResult> {
  let raw: string | null;
  try {
    raw = (await sysRedis.hGet(REDIS_SYS_KEYS.SEARCH_INDEX_CLEANUP.CURSORS, FIELD(key))) ?? null;
  } catch {
    return { cursor: null, reason: 'unreadable' };
  }
  if (raw === null || raw === undefined || raw === '') return { cursor: null, reason: 'missing' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { cursor: null, reason: 'unparseable' };
  }
  if (!parsed || typeof parsed !== 'object') return { cursor: null, reason: 'invalid' };

  const rec = parsed as Record<string, unknown>;
  const { lastId, startedAt, covered } = rec;
  // `typeof NaN === 'number'`, and NaN survives every comparison below as false, so it
  // would read as a cursor whose age can never exceed the bound. Check finiteness.
  if (typeof lastId !== 'number' || !Number.isFinite(lastId) || lastId < 0)
    return { cursor: null, reason: 'invalid' };
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt))
    return { cursor: null, reason: 'invalid' };
  if (typeof covered !== 'number' || !Number.isFinite(covered) || covered < 0)
    return { cursor: null, reason: 'invalid' };
  // 🔴 `covered` is the sole input to both coverage judgements — whether an empty page
  // is believed, and whether the pass is credited as finished — so an absurd value
  // silently credits a pass that covered nothing. Ids are non-negative and strictly
  // increasing, so a pass standing at `lastId` cannot have walked past more than
  // `lastId + 1` of them. That is a structural invariant, not a heuristic.
  //
  // What this does NOT catch: an index rebuilt or bulk-deleted between runs, which
  // shrinks `totalInIndex` while `covered` legitimately carries the old, larger figure.
  // No validation here can see that. It self-heals in one night — the resumed page sits
  // above every surviving id, so the scan gets an empty page at apparently-complete
  // coverage, credits the pass, clears the cursor, and the next run walks the rebuilt
  // index from the bottom.
  if (covered > lastId + 1) return { cursor: null, reason: 'invalid' };

  const age = now - startedAt;
  // A future-dated `startedAt` (clock skew, or a hand-edited value) would make `age`
  // negative and pass an upper-bound test forever, which is the one way the staleness
  // bound could be defeated silently. Treat it as stale.
  if (age < 0 || age > MAX_CURSOR_AGE_MS) return { cursor: null, reason: 'stale' };

  return { cursor: { lastId, startedAt, covered }, reason: 'none' };
}

/** Persist the point a truncated pass stopped at. Failure is reported, never thrown. */
export async function writeScanCursor(key: string, cursor: ScanCursor): Promise<boolean> {
  try {
    await sysRedis.hSet(
      REDIS_SYS_KEYS.SEARCH_INDEX_CLEANUP.CURSORS,
      FIELD(key),
      JSON.stringify(cursor)
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop the cursor so the next run starts over from the bottom.
 *
 * Called only when a pass genuinely completed. Without it the cursor would sit at the
 * top of the index forever and the low-id region — where documents that were eligible
 * when indexed and have since gone stale actually live — would never be re-examined.
 */
export async function clearScanCursor(key: string): Promise<boolean> {
  try {
    await sysRedis.hDel(REDIS_SYS_KEYS.SEARCH_INDEX_CLEANUP.CURSORS, FIELD(key));
    return true;
  } catch {
    return false;
  }
}
