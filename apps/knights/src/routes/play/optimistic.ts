/** What the page shows for one thing to judge: the question, the sealed item, and a banner when the question changed. */
export type PickedItem = {
  question: {
    key: string;
    kind: string;
    prompt: string;
    options: { value: string; label: string }[];
  };
  item: { id: string; src: string; width: number | null; height: number | null };
  banner: { heading: string } | null;
};

/** Items the next-stretch query leaves out: the ones already sent and the one on screen. */
export const MAX_EXCLUDED = 4;

export const NETWORK_NOTICE =
  'Your last judgment may not have been recorded: check your connection.';
const FAILED_NOTICE = 'Your judgment could not be recorded.';

/**
 * Bookkeeping for votes posted in the background: an item is sent once, and the next stretch is asked for without
 * the items whose votes may not have landed yet.
 */
export function createVoteTracker() {
  const sent: string[] = [];
  let inFlight = 0;
  return {
    /** False when this item was already sent; the caller must not post it again. */
    claim(token: string): boolean {
      if (sent.includes(token)) return false;
      sent.push(token);
      inFlight += 1;
      return true;
    },
    settle() {
      inFlight = Math.max(0, inFlight - 1);
    },
    get pending() {
      return inFlight;
    },
    excluded(current: string): string[] {
      return [...sent.filter((token) => token !== current), current].slice(-MAX_EXCLUDED);
    },
  };
}

type Outcome = { type: string; status?: number; data?: Record<string, unknown> };
export type VoteOutcome = { ok: true } | { ok: false; message: string; resync: boolean };

/**
 * What a background vote came back with. A refused vote is only worth a notice, since the player has moved on; one that
 * paces the player, or that no longer matches the session, needs the page reloaded to show the rest.
 */
export function describeOutcome(result: Outcome | null): VoteOutcome {
  if (!result) return { ok: false, message: NETWORK_NOTICE, resync: false };
  if (result.type === 'success') return { ok: true };
  if (result.type === 'failure') {
    const message = result.data?.message;
    return {
      ok: false,
      message: typeof message === 'string' && message ? message : FAILED_NOTICE,
      resync: typeof result.data?.lockoutSeconds === 'number',
    };
  }
  return { ok: false, message: FAILED_NOTICE, resync: true };
}
