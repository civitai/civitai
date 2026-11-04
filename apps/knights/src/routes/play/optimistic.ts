/** What the page shows for one thing to judge: the question, the sealed item, and a banner when the question changed. */
export type PickedItem = {
  question: {
    key: string;
    kind: string;
    prompt: string;
    options: { value: string; label: string }[];
  };
  item: { id: string; key: string; src: string; width: number | null; height: number | null };
  banner: { heading: string } | null;
};

/**
 * What makes two servings the same thing to judge. The token is sealed afresh every time an item is served, so it cannot
 * tell; the question and the (public) image address can. Nothing in it names an item row.
 */
export const itemKey = (questionKey: string, src: string) => `${questionKey}:${src}`;

/** Items the next-stretch query leaves out: the ones already sent and the one on screen. */
export const MAX_EXCLUDED = 8;

/** Items kept downloaded ahead of the one on screen; more are asked for whenever fewer are ready. */
export const BUFFER_TARGET = 3;

export const NETWORK_NOTICE =
  'Your last judgment may not have been recorded: check your connection.';
const FAILED_NOTICE = 'Your judgment could not be recorded.';

/**
 * Bookkeeping for votes posted in the background: an item is sent once (by key, since its token changes each time it is
 * served), and the next stretch is asked for without the items whose votes may not have landed yet or that would not load.
 */
export function createVoteTracker() {
  const sent: { key: string; token: string }[] = [];
  let avoided: string[] = [];
  let inFlight = 0;
  return {
    /** False when this item was already sent; the caller must not post it again. */
    claim(key: string, token: string): boolean {
      if (sent.some((entry) => entry.key === key)) return false;
      sent.push({ key, token });
      inFlight += 1;
      return true;
    },
    has(key: string): boolean {
      return sent.some((entry) => entry.key === key);
    },
    settle() {
      inFlight = Math.max(0, inFlight - 1);
    },
    /** A vote that never reached the server: the item may be served again, and must be votable when it is. */
    release(key: string) {
      const at = sent.findIndex((entry) => entry.key === key);
      if (at >= 0) sent.splice(at, 1);
    },
    /** An item that could not be loaded: left out of the next stretches, though nothing was sent for it. */
    avoid(token: string) {
      if (avoided.includes(token)) return;
      avoided = [...avoided, token].slice(-MAX_EXCLUDED);
    },
    get pending() {
      return inFlight;
    },
    excluded(current: string): string[] {
      const tokens = [...avoided, ...sent.map((entry) => entry.token)];
      return [...tokens.filter((token) => token !== current), current].slice(-MAX_EXCLUDED);
    },
  };
}

/**
 * Items fetched and decoded ahead of the one on screen, in the order they were picked. Only an item whose key is neither
 * buffered nor already known (sent, on screen) gets in, so a repeat, a re-sealed token or a stale reply cannot show an
 * item twice.
 */
export function createItemBuffer(target = BUFFER_TARGET) {
  let items: PickedItem[] = [];
  return {
    /** False when the item is a repeat, already known to the caller, or the buffer is full. */
    enqueue(item: PickedItem, known: (key: string) => boolean): boolean {
      const key = item.item.key;
      if (items.length >= target || known(key) || items.some((it) => it.item.key === key))
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
    drop(key: string) {
      items = items.filter((it) => it.item.key !== key);
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
      return items.length < target;
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
