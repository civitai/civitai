import type { BuzzReadOptions } from '@civitai/buzz';

/**
 * The balance shown in the header, which every signed-in page asks for. It is DISPLAY data: a spend
 * re-reads the balance on its own path, so what this returns never decides whether money moves.
 *
 * Two rules, both about the buzz service being slow or down:
 * - the read is bounded tightly (`BALANCE_DISPLAY_READ`), so a hung service costs a page 2s, not
 *   the client's general read budget;
 * - when it fails, the last balance this pod read for the user is served instead, for up to
 *   `BALANCE_STALE_MAX_MS`. A successful read always wins, so a balance never goes stale while the
 *   service answers: the header's refetch after a spend shows the new figure.
 *
 * Deliberately no fresh-hit cache: serving a cached figure while the service is healthy would show
 * the pre-spend balance after the client's invalidate-and-refetch.
 */
export const BALANCE_DISPLAY_READ = { timeoutMs: 2_000, retries: 0 } satisfies BuzzReadOptions;
export const BALANCE_STALE_MAX_MS = 10 * 60 * 1000;
const MAX_REMEMBERED_USERS = 20_000;

export function createBalanceDisplayReader<T>(
  read: (userId: number, opts: BuzzReadOptions) => Promise<T>,
  now: () => number = Date.now
) {
  const lastKnown = new Map<number, { at: number; value: T }>();

  return async function readForDisplay(userId: number): Promise<T> {
    try {
      const value = await read(userId, BALANCE_DISPLAY_READ);
      // Re-insert so Map order is recency order, and the oldest entry is the one evicted.
      lastKnown.delete(userId);
      lastKnown.set(userId, { at: now(), value });
      if (lastKnown.size > MAX_REMEMBERED_USERS) {
        const oldest = lastKnown.keys().next().value;
        if (oldest !== undefined) lastKnown.delete(oldest);
      }
      return value;
    } catch (error) {
      const remembered = lastKnown.get(userId);
      if (remembered && now() - remembered.at <= BALANCE_STALE_MAX_MS) return remembered.value;
      throw error;
    }
  };
}
