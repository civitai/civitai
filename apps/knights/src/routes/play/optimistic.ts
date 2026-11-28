import { encodeSignals, PRESS_FIELDS, type PressSignals } from '$lib/press';

/** What the page shows for one thing to judge: the question, the sealed item, and a banner when the question changed, and the category of a yes/no question. */
export type PickedItem = {
  question: {
    key: string;
    kind: string;
    prompt: string;
    options: { value: string; label: string }[];
  };
  item: {
    id: string;
    key: string;
    src: string;
    width: number | null;
    height: number | null;
    /** The opaque name live drops use for this item (`live-key.ts`). */
    live: string;
    /** A yes/no question the player may report; absent on everything else. */
    reportable?: boolean;
  };
  banner: { heading: string } | null;
  category: { heading: string } | null;
};

/**
 * What makes two servings the same thing to judge. The token is sealed afresh every time an item is served, so it cannot
 * tell; the question and the (public) image address can. Nothing in it names an item row.
 */
export const itemKey = (questionKey: string, src: string) => `${questionKey}:${src}`;

/**
 * Items the next-stretch query leaves out: a full buffer, the one on screen and the votes still in flight. A sealed token
 * is 91 characters, so even this many keep the URL near 2.5 KB.
 */
export const MAX_EXCLUDED = 24;

/**
 * Items kept downloaded ahead of the one on screen (the first READY_TARGET of them decoded). Kept short: under load an item
 * resolves within seconds, and one held longer is often closed by the time it is judged (11-18: about 1 in 4 votes).
 */
export const BUFFER_TARGET = 3;

/** How many of the buffered items, from the front, are decoded and ready to be shown at once. */
export const READY_TARGET = 3;

/** More are asked for whenever this many or fewer are buffered. */
export const REFILL_AT = 2;

export const NETWORK_NOTICE =
  'Your last judgment may not have been recorded: check your connection.';
const FAILED_NOTICE = 'Your judgment could not be recorded.';

const NOT_COUNTED = 'That judgment was not counted.';

export const HEART_CUE = '+1 toward your next heart';

/**
 * The cue a recorded vote earns: a right skill check while a smite weighed on the player when they answered (`smitesBefore`,
 * read at the press, since the page data may already be fresher).
 */
export function skillCheckCue(
  result: Record<string, unknown> | undefined,
  smitesBefore: number
): string | null {
  const check = result?.check as { verdict?: unknown } | undefined;
  return check?.verdict === 'correct' && smitesBefore > 0 ? HEART_CUE : null;
}

/**
 * Refusals that mean the item moved on while it waited to be judged (settled, escalated past the player's rank, or
 * withdrawn), not that the player did anything wrong.
 */
/** Refusals for an item that moved on (settled, escalated, withdrawn) while it waited in the buffer. */
export const STALE_REASONS: ReadonlySet<string> = new Set([
  'not-open',
  'not-eligible',
  'unavailable',
]);

/** A background vote the server refused: by then the player has moved on, so the note says the press did not count. */
export const refusedNote = (message: string) =>
  message === NETWORK_NOTICE || message.includes(NOT_COUNTED)
    ? message
    : `${message} ${NOT_COUNTED}`;

/**
 * Bookkeeping for votes posted in the background: an item is sent once (by key, since its token changes each time it is
 * served), and the next stretch is asked for without the items whose votes may not have landed yet or that would not load.
 */
export function createVoteTracker() {
  const sent: { key: string; token: string; vote: boolean; live: boolean }[] = [];
  let avoided: string[] = [];
  let inFlight = 0;
  return {
    /** False when this item was already sent; the caller must not post it again. */
    claim(key: string, token: string, vote = true): boolean {
      if (sent.some((entry) => entry.key === key)) return false;
      sent.push({ key, token, vote, live: true });
      inFlight += 1;
      return true;
    },
    has(key: string): boolean {
      return sent.some((entry) => entry.key === key);
    },
    settle(key?: string) {
      inFlight = Math.max(0, inFlight - 1);
      const entry = sent.find((it) => it.key === key);
      if (entry) entry.live = false;
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
    /**
     * Tokens of the votes still in flight, not yet on the server's ledger: what the picker counts as already judged. A skip
     * or an item that would not load is not one (it never gets a vote), so neither is in here.
     */
    voting(): string[] {
      return sent.filter((entry) => entry.vote && entry.live).map((entry) => entry.token);
    },
    excluded(current: string): string[] {
      const tokens = [...avoided, ...sent.map((entry) => entry.token)];
      return [...tokens.filter((token) => token !== current), current].slice(-MAX_EXCLUDED);
    },
  };
}

type Buffered = { item: PickedItem; decoded: boolean; claimed: boolean };

/**
 * Items fetched ahead of the one on screen, in the order they were picked, in two layers: all of them are downloaded (their
 * image requested into the browser cache), and the first `ready` are also decoded and can be shown at once. Consuming one
 * promotes the next downloaded item into the decoded window. Only an item whose key is neither buffered nor already known
 * (sent, on screen) gets in, so a repeat, a re-sealed token or a stale reply cannot show an item twice.
 */
export function createItemBuffer({
  total = BUFFER_TARGET,
  ready = READY_TARGET,
  refillAt = REFILL_AT,
} = {}) {
  let items: Buffered[] = [];
  return {
    /** False when the item is a repeat, already known to the caller, or the buffer is full. */
    enqueue(item: PickedItem, known: (key: string) => boolean): boolean {
      const key = item.item.key;
      if (items.length >= total || known(key) || items.some((it) => it.item.item.key === key))
        return false;
      items.push({ item, decoded: false, claimed: false });
      return true;
    },
    /** The head, once its image is decoded: the only item a vote may swap to without waiting. */
    peek(): PickedItem | null {
      const head = items[0];
      return head?.decoded ? head.item : null;
    },
    next(): PickedItem | null {
      return items.shift()?.item ?? null;
    },
    /** Items in the decoded window that no one is decoding yet; each is handed out once. */
    toDecode(): PickedItem[] {
      const due = items.slice(0, ready).filter((it) => !it.decoded && !it.claimed);
      for (const it of due) it.claimed = true;
      return due.map((it) => it.item);
    },
    /** False when the item has left the buffer since its decode began. */
    markDecoded(key: string): boolean {
      const found = items.find((it) => it.item.item.key === key);
      if (!found) return false;
      found.decoded = true;
      return true;
    },
    drop(key: string) {
      items = items.filter((it) => it.item.item.key !== key);
    },
    /** Drops the items whose live key is in `gone`; returns their item keys. */
    dropLive(gone: ReadonlySet<string>): string[] {
      const dropped = items.filter((it) => gone.has(it.item.item.live));
      items = items.filter((it) => !dropped.includes(it));
      return dropped.map((it) => it.item.item.key);
    },
    clear() {
      items = [];
    },
    get size() {
      return items.length;
    },
    get readyCount() {
      return items.filter((it) => it.decoded).length;
    },
    tokens(): string[] {
      return items.map((it) => it.item.item.id);
    },
    needsRefill(): boolean {
      return items.length <= refillAt;
    },
    /** How many to ask for to fill the buffer. */
    missing(): number {
      return Math.max(0, total - items.length);
    },
  };
}

/** An empty buffer asks only for the ready layer: a full batch is picked one item at a time, and the first swap waits on it. */
export const refillCount = (size: number): number =>
  size === 0 ? READY_TARGET : Math.max(1, BUFFER_TARGET - size);

type Outcome = { type: string; status?: number; data?: Record<string, unknown> };
export type VoteOutcome =
  | { ok: true }
  | {
      ok: false;
      message: string;
      resync: boolean;
      stale: boolean;
      /** A stale judgment the server still counted toward the Daily Watch (no gold). */
      watchCounted?: boolean;
    };

/** The note a refused background vote leaves, or none for a stale item: the player is already on the next one. */
export const refusalNote = (outcome: Extract<VoteOutcome, { ok: false }>): string | null =>
  outcome.stale ? null : refusedNote(outcome.message);

/** The server's answer when too many of one player's votes are in flight at once: not a rate limit, so the vote is simply sent again. */
export const isBusy = (result: Outcome | null): boolean =>
  result?.type === 'failure' && result.data?.busy === true;

/** How long to wait before each resend of a vote the server found busy; no more resends than there are delays. */
export const BUSY_RETRY_DELAYS_MS = [400, 1200, 3000];

/** Sends a vote, and sends it again after a short wait while the server says it is busy. */
export async function sendWithRetry(
  send: () => Promise<Outcome | null>,
  wait: (ms: number) => Promise<void>,
  delays: readonly number[] = BUSY_RETRY_DELAYS_MS
): Promise<Outcome | null> {
  let result = await send();
  for (const ms of delays) {
    if (!isBusy(result)) break;
    await wait(ms);
    result = await send();
  }
  return result;
}

/** Runs tasks one at a time, in the order they were added: the next starts only after the previous has settled. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    add<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

export type PressClock = { wall: () => number; mono: () => number };
const systemClock: PressClock = { wall: () => Date.now(), mono: () => performance.now() };

/**
 * Stamps a vote body with the press fields. `waitedMs` uses the monotonic clock, so unlike the wall-clock gap the server
 * works out it has no skew in it; the returned call sets it once, at the first start of the post (a resend keeps it).
 */
export function markPress(
  body: FormData,
  signals: PressSignals,
  clock: PressClock = systemClock
): () => void {
  const pressed = clock.mono();
  body.set(PRESS_FIELDS.pressedAt, String(clock.wall()));
  body.set(PRESS_FIELDS.signals, encodeSignals(signals));
  return () => {
    if (body.has(PRESS_FIELDS.waitedMs)) return;
    body.set(PRESS_FIELDS.waitedMs, String(Math.max(0, Math.round(clock.mono() - pressed))));
  };
}

/** A post that has had no answer by then is given up on, so one hung request cannot hold up the votes queued behind it. */
export const POST_TIMEOUT_MS = 15_000;

export type VoteSend = (
  signal: AbortSignal
) => Promise<{ reached: boolean; result: Outcome | null }>;

export type PostVoteDeps = {
  queue: ReturnType<typeof createSerialQueue>;
  tracker: ReturnType<typeof createVoteTracker>;
  /** Posts the vote once. `reached` is true only for an answer that was read in full; an abort or a lost connection is not. */
  send: VoteSend;
  wait: (ms: number) => Promise<void>;
  /** When the vote leaves the queue and its first post starts. */
  onStart?: () => void;
  /** A vote that came back as anything but recorded: the notice, and whether the page must be read again. */
  onFailure: (outcome: Extract<VoteOutcome, { ok: false }>) => void;
  /** A recorded vote, with what the action returned (a skill check graded on the spot carries `check`). */
  onSuccess?: (data: Record<string, unknown> | undefined) => void;
  /** After the vote has settled, whatever it came to. */
  onSettled: () => Promise<void>;
  timeoutMs?: number;
  retryDelays?: readonly number[];
};

/**
 * Posts one background vote in its turn, resends it while the server is busy, and settles it. A vote the server may not
 * have recorded (never reached it, timed out, or still busy after the last resend) frees its item to be answered again.
 */
export async function postVote(key: string, deps: PostVoteDeps): Promise<void> {
  const { queue, tracker, send, wait, onFailure, onSettled } = deps;
  let reached = false;
  const attempt = async () => {
    const sent = await send(AbortSignal.timeout(deps.timeoutMs ?? POST_TIMEOUT_MS));
    reached = sent.reached;
    return sent.result;
  };
  const result = await queue.add(() => {
    deps.onStart?.();
    return sendWithRetry(attempt, wait, deps.retryDelays);
  });
  const outcome = describeOutcome(result);
  tracker.settle(key);
  if (!reached || isBusy(result)) tracker.release(key);
  // A throwing handler must not skip the settle: it lands the vote and reads the page again.
  try {
    if (!outcome.ok) onFailure(outcome);
    else deps.onSuccess?.(result?.data);
  } catch (error) {
    console.error('knights: a vote handler failed', error);
  } finally {
    await onSettled();
  }
}

/**
 * What a background vote came back with. A refused vote is only worth a notice, since the player has moved on; one that
 * paces the player, or that no longer matches the session, needs the page reloaded to show the rest.
 */
export function describeOutcome(result: Outcome | null): VoteOutcome {
  if (!result) return { ok: false, message: NETWORK_NOTICE, resync: false, stale: false };
  if (result.type === 'success') return { ok: true };
  if (result.type === 'failure') {
    const message = result.data?.message;
    return {
      ok: false,
      message: typeof message === 'string' && message ? message : FAILED_NOTICE,
      resync: typeof result.data?.lockoutSeconds === 'number',
      stale: typeof result.data?.reason === 'string' && STALE_REASONS.has(result.data.reason),
      ...(result.data?.watchCounted === true ? { watchCounted: true } : {}),
    };
  }
  return { ok: false, message: FAILED_NOTICE, resync: true, stale: false };
}
