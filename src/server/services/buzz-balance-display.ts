import type { BuzzReadOptions } from '@civitai/buzz';

/**
 * The read behind `buzz.getBuzzAccount`. Every signed-in page's header asks for it, and so does
 * `useBuzz`/`useQueryBuzz`, the client's general balance hook, which components also use for
 * affordability checks (whether to enable a spend button, show "not enough Buzz"). It is NOT only
 * display. What it never does is authorise a charge: the server re-reads the balance on every
 * spend path (`createBuzzTransaction`'s pre-check, the ledger itself).
 *
 * Two rules, both about the buzz service being slow or down:
 * - the read is bounded tightly (`BALANCE_DISPLAY_READ`), so a hung service costs a page 2s, not
 *   the client's general read budget. Always on.
 * - DARK by default: with `BUZZ_BALANCE_SERVE_STALE=true`, a failed read serves the last balance
 *   this pod read for the user, for up to `BALANCE_STALE_MAX_MS`. Absent (or anything else), a
 *   failure is an error, as before. A stale figure can make an affordability check in the client
 *   say yes to a spend the server will then refuse, which is why it waits behind a flag. A
 *   successful read always wins, so a balance never goes stale while the service answers.
 *
 * Deliberately no fresh-hit cache: serving a cached figure while the service is healthy would show
 * the pre-spend balance after the client's invalidate-and-refetch.
 */
export const BALANCE_DISPLAY_READ = { timeoutMs: 2_000, retries: 0 } satisfies BuzzReadOptions;
export const BALANCE_STALE_MAX_MS = 10 * 60 * 1000;
const MAX_REMEMBERED_USERS = 20_000;

/** Read per request, so flipping it needs no rebuild of the reader. Absent means off. */
const serveStaleEnabled = () => process.env.BUZZ_BALANCE_SERVE_STALE === 'true';

export function createBalanceDisplayReader<T>(
  read: (userId: number, opts: BuzzReadOptions) => Promise<T>,
  now: () => number = Date.now
) {
  const lastKnown = new Map<number, { at: number; value: T }>();

  return async function readForDisplay(userId: number): Promise<T> {
    try {
      const value = await read(userId, BALANCE_DISPLAY_READ);
      // Remembered whether or not the fallback is on: one guard (below) decides what is served.
      // Re-insert so Map order is recency order, and the oldest entry is the one evicted.
      lastKnown.delete(userId);
      lastKnown.set(userId, { at: now(), value });
      if (lastKnown.size > MAX_REMEMBERED_USERS) {
        const oldest = lastKnown.keys().next().value;
        if (oldest !== undefined) lastKnown.delete(oldest);
      }
      return value;
    } catch (error) {
      if (!serveStaleEnabled()) throw error;
      const remembered = lastKnown.get(userId);
      if (remembered && now() - remembered.at <= BALANCE_STALE_MAX_MS) return remembered.value;
      throw error;
    }
  };
}
