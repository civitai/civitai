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
export const MAX_EXCLUDED = 8;

/** Items kept downloaded ahead of the one on screen, and the size below which more are asked for. */
export const BUFFER_TARGET = 3;
export const BUFFER_REFILL_BELOW = 2;

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
    has(token: string): boolean {
      return sent.includes(token);
    },
    settle() {
      inFlight = Math.max(0, inFlight - 1);
    },
    /** A vote that never reached the server: the item may be served again, and must be votable when it is. */
    release(token: string) {
      const at = sent.indexOf(token);
      if (at >= 0) sent.splice(at, 1);
    },
    get pending() {
      return inFlight;
    },
    excluded(current: string): string[] {
      return [...sent.filter((token) => token !== current), current].slice(-MAX_EXCLUDED);
    },
  };
}

/**
 * Items fetched and decoded ahead of the one on screen, in the order they were picked. Only an item that is neither
 * buffered nor already known (sent, on screen) gets in, so a repeat or a stale reply cannot show an item twice.
 */
export function createItemBuffer(target = BUFFER_TARGET, refillBelow = BUFFER_REFILL_BELOW) {
  let items: PickedItem[] = [];
  return {
    /** False when the item is a repeat, already known to the caller, or the buffer is full. */
    enqueue(item: PickedItem, known: (token: string) => boolean): boolean {
      const token = item.item.id;
      if (items.length >= target || known(token) || items.some((it) => it.item.id === token))
        return false;
      items.push(item);
      return true;
    },
    peek(): PickedItem | null {
      return items[0] ?? null;
    },
    next(): PickedItem | null {
      return items.shift() ?? null;
    },
    drop(token: string) {
      items = items.filter((it) => it.item.id !== token);
    },
    clear() {
      items = [];
    },
    get size() {
      return items.length;
    },
    tokens(): string[] {
      return items.map((it) => it.item.id);
    },
    needsRefill(): boolean {
      return items.length < refillBelow;
    },
    /** How many to ask for to fill the buffer. */
    missing(): number {
      return Math.max(0, target - items.length);
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
