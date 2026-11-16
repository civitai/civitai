import { describe, expect, it, vi } from 'vitest';
import {
  BUFFER_TARGET,
  refillCount,
  READY_TARGET,
  REFILL_AT,
  MAX_EXCLUDED,
  createItemBuffer,
  createSerialQueue,
  createVoteTracker,
  describeOutcome,
  itemKey,
  postVote,
  sendWithRetry,
} from './optimistic';
import type { PickedItem } from './optimistic';

describe('createVoteTracker', () => {
  it('lets an item be sent once and refuses a second send of the same key, whatever its token', () => {
    const tracker = createVoteTracker();
    expect(tracker.claim('ka', 'ta1')).toBe(true);
    expect(tracker.claim('ka', 'ta1')).toBe(false);
    expect(tracker.claim('ka', 'ta2')).toBe(false);
    expect(tracker.claim('kb', 'tb')).toBe(true);
  });

  it('recognises a re-issued token for an item that was already sent, by its key', () => {
    const tracker = createVoteTracker();
    tracker.claim('ka', 'ta1');
    expect(tracker.has('ka')).toBe(true);
    expect(tracker.has('kb')).toBe(false);
  });

  it('lets an item be sent again once a vote that never reached the server is released', () => {
    const tracker = createVoteTracker();
    expect(tracker.claim('ka', 'ta')).toBe(true);
    tracker.release('ka');
    expect(tracker.has('ka')).toBe(false);
    expect(tracker.claim('ka', 'ta')).toBe(true);
    expect(tracker.excluded('tb')).toEqual(['ta', 'tb']);
  });

  it('counts the votes in flight until each settles, never below zero', () => {
    const tracker = createVoteTracker();
    tracker.claim('ka', 'ta');
    tracker.claim('kb', 'tb');
    expect(tracker.pending).toBe(2);
    tracker.settle();
    tracker.settle();
    tracker.settle();
    expect(tracker.pending).toBe(0);
  });

  it('names the tokens to leave out of the next stretch: the ones sent and the one on screen, newest last', () => {
    const tracker = createVoteTracker();
    tracker.claim('ka', 'ta');
    tracker.claim('kb', 'tb');
    expect(tracker.excluded('tc')).toEqual(['ta', 'tb', 'tc']);
    expect(tracker.excluded('tb')).toEqual(['ta', 'tb']);
  });

  it('lists as voting only the votes still in flight: not skips, not settled votes, not avoided items', () => {
    const tracker = createVoteTracker();
    tracker.claim('a', 'ta', false); // a skip
    tracker.claim('b', 'tb');
    tracker.claim('c', 'tc');
    tracker.avoid('td');
    tracker.settle('b');
    expect(tracker.voting()).toEqual(['tc']);
    tracker.settle('c');
    expect(tracker.voting()).toEqual([]);
  });

  it('keeps only the most recent items, so the query stays small', () => {
    const tracker = createVoteTracker();
    for (let i = 0; i < MAX_EXCLUDED + 3; i += 1) tracker.claim(`k${i}`, `t${i}`);
    const excluded = tracker.excluded('now');
    expect(excluded).toHaveLength(MAX_EXCLUDED);
    expect(excluded.at(-1)).toBe('now');
    expect(excluded.at(-2)).toBe(`t${MAX_EXCLUDED + 2}`);
  });

  it('has room for a full buffer, the one on screen and a few votes in flight', () => {
    expect(MAX_EXCLUDED).toBeGreaterThanOrEqual(BUFFER_TARGET + 1 + 5);
  });

  it('leaves out an item whose image would not decode, without counting it as sent', () => {
    const tracker = createVoteTracker();
    tracker.avoid('tbad');
    tracker.avoid('tbad');
    expect(tracker.has('kbad')).toBe(false);
    expect(tracker.pending).toBe(0);
    tracker.claim('ka', 'ta');
    expect(tracker.excluded('tc')).toEqual(['tbad', 'ta', 'tc']);
  });

  it('never lets avoided items push the cap past MAX_EXCLUDED', () => {
    const tracker = createVoteTracker();
    for (let i = 0; i < MAX_EXCLUDED * 2; i += 1) tracker.avoid(`bad${i}`);
    expect(tracker.excluded('now')).toHaveLength(MAX_EXCLUDED);
    expect(tracker.excluded('now').at(-1)).toBe('now');
  });
});

describe('describeOutcome', () => {
  it('treats a success as nothing to say', () => {
    expect(describeOutcome({ type: 'success', status: 200, data: { success: true } })).toEqual({
      ok: true,
    });
  });

  it('carries a refused vote message and does not resync for an item that is simply settled', () => {
    expect(
      describeOutcome({
        type: 'failure',
        status: 409,
        data: { message: 'You have already judged this one.' },
      })
    ).toEqual({ ok: false, message: 'You have already judged this one.', resync: false });
  });

  it('resyncs when the server paces the player, because the page must show the rest', () => {
    expect(
      describeOutcome({
        type: 'failure',
        status: 429,
        data: { message: 'You are judging too quickly. Rest a little.', lockoutSeconds: 30 },
      })
    ).toMatchObject({ ok: false, resync: true });
  });

  it('falls back to a plain message when the failure carries none, and for a lost connection', () => {
    expect(describeOutcome({ type: 'failure', status: 500 })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/could not be recorded/),
    });
    expect(describeOutcome(null)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/connection/i),
      resync: false,
    });
  });

  it('resyncs on a redirect or error, where the page no longer matches the session', () => {
    expect(describeOutcome({ type: 'redirect' })).toMatchObject({ ok: false, resync: true });
    expect(describeOutcome({ type: 'error' })).toMatchObject({ ok: false, resync: true });
  });
});

const picked = (id: string, key = id): PickedItem => ({
  question: { key: 'q', kind: 'rating', prompt: 'Rate it', options: [] },
  item: { id, key, src: `cdn/${id}`, width: 1, height: 1 },
  banner: null,
  category: null,
});
const never = () => false;

describe('itemKey', () => {
  it('is the question and the image, so a re-sealed token for the same item has the same key', () => {
    expect(itemKey('q', 'cdn/a.jpg')).toBe(itemKey('q', 'cdn/a.jpg'));
    expect(itemKey('q', 'cdn/a.jpg')).not.toBe(itemKey('yesno', 'cdn/a.jpg'));
    expect(itemKey('q', 'cdn/a.jpg')).not.toBe(itemKey('q', 'cdn/b.jpg'));
  });
});

describe('createItemBuffer', () => {
  const fill = (buffer: ReturnType<typeof createItemBuffer>, ids: string[]) =>
    ids.forEach((id) => buffer.enqueue(picked(id), never));
  const decode = (buffer: ReturnType<typeof createItemBuffer>) => {
    const started = buffer.toDecode().map((it) => it.item.id);
    started.forEach((id) => buffer.markDecoded(id));
    return started;
  };

  it('holds 10 downloaded, 3 of them ready, and refills from 5 down', () => {
    expect(BUFFER_TARGET).toBe(10);
    expect(READY_TARGET).toBe(3);
    expect(REFILL_AT).toBe(5);
  });

  it('hands items out in the order they were enqueued, the head only once it is decoded', () => {
    const buffer = createItemBuffer();
    fill(buffer, ['a', 'b']);
    expect(buffer.peek()).toBeNull();
    decode(buffer);
    expect(buffer.peek()?.item.id).toBe('a');
    expect(buffer.next()?.item.id).toBe('a');
    expect(buffer.next()?.item.id).toBe('b');
    expect(buffer.next()).toBeNull();
  });

  it('asks to decode only the first three, and only once each', () => {
    const buffer = createItemBuffer();
    fill(buffer, ['a', 'b', 'c', 'd', 'e']);
    expect(buffer.toDecode().map((it) => it.item.id)).toEqual(['a', 'b', 'c']);
    expect(buffer.toDecode()).toEqual([]);
    expect(buffer.readyCount).toBe(0);
    buffer.markDecoded('a');
    expect(buffer.readyCount).toBe(1);
  });

  it('promotes the next downloaded item to be decoded when a ready one is consumed', () => {
    const buffer = createItemBuffer();
    fill(buffer, ['a', 'b', 'c', 'd', 'e']);
    expect(decode(buffer)).toEqual(['a', 'b', 'c']);
    expect(buffer.next()?.item.id).toBe('a');
    expect(buffer.toDecode().map((it) => it.item.id)).toEqual(['d']);
    expect(buffer.peek()?.item.id).toBe('b');
    buffer.markDecoded('d');
    expect(buffer.readyCount).toBe(3);
  });

  it('promotes the next item when a ready one is dropped, and fills the window as items arrive', () => {
    const buffer = createItemBuffer();
    fill(buffer, ['a', 'b']);
    expect(decode(buffer)).toEqual(['a', 'b']);
    fill(buffer, ['c', 'd']);
    expect(decode(buffer)).toEqual(['c']);
    buffer.drop('a');
    expect(decode(buffer)).toEqual(['d']);
  });

  it('ignores a decode that finishes after its item left', () => {
    const buffer = createItemBuffer();
    fill(buffer, ['a']);
    buffer.toDecode();
    buffer.drop('a');
    expect(buffer.markDecoded('a')).toBe(false);
    expect(buffer.readyCount).toBe(0);
  });

  it('refuses a repeat or an item the caller already knows, in either layer, and anything past the total', () => {
    const buffer = createItemBuffer({ total: 4, ready: 2, refillAt: 2 });
    expect(buffer.enqueue(picked('a'), never)).toBe(true);
    decode(buffer);
    expect(buffer.enqueue(picked('a'), never)).toBe(false);
    expect(buffer.enqueue(picked('b'), (key) => key === 'b')).toBe(false);
    expect(buffer.enqueue(picked('c'), never)).toBe(true);
    expect(buffer.enqueue(picked('c'), never)).toBe(false);
    expect(buffer.enqueue(picked('d'), never)).toBe(true);
    expect(buffer.enqueue(picked('e'), never)).toBe(true);
    expect(buffer.enqueue(picked('f'), never)).toBe(false);
    expect(buffer.tokens()).toEqual(['a', 'c', 'd', 'e']);
  });

  it('treats the same key under a different token as a repeat', () => {
    const buffer = createItemBuffer();
    expect(buffer.enqueue(picked('token-1', 'same'), never)).toBe(true);
    expect(buffer.enqueue(picked('token-2', 'same'), never)).toBe(false);
    expect(buffer.enqueue(picked('token-3', 'sent'), (key) => key === 'sent')).toBe(false);
    expect(buffer.tokens()).toEqual(['token-1']);
  });

  it('asks for more once downloaded plus ready is 5 or fewer, and for enough to reach 10', () => {
    const buffer = createItemBuffer();
    expect(buffer.needsRefill()).toBe(true);
    expect(buffer.missing()).toBe(10);
    fill(buffer, ['a', 'b', 'c', 'd', 'e', 'f']);
    expect(buffer.needsRefill()).toBe(false);
    expect(buffer.missing()).toBe(4);
    buffer.next();
    expect(buffer.size).toBe(5);
    expect(buffer.needsRefill()).toBe(true);
    expect(buffer.missing()).toBe(5);
    fill(buffer, ['g', 'h', 'i', 'j', 'k']);
    expect(buffer.missing()).toBe(0);
    expect(buffer.needsRefill()).toBe(false);
  });

  it('drops one item by key and clears all', () => {
    const buffer = createItemBuffer();
    for (const id of ['a', 'b', 'c']) buffer.enqueue(picked(`t${id}`, id), never);
    buffer.drop('b');
    expect(buffer.tokens()).toEqual(['ta', 'tc']);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.readyCount).toBe(0);
  });
});

describe('refillCount', () => {
  it('asks for only the ready layer while the buffer is empty, so the first swap is not held behind a long request', () => {
    expect(refillCount(0)).toBe(3);
  });

  it('tops up to the full buffer otherwise, always asking for at least one', () => {
    expect(refillCount(4)).toBe(6);
    expect(refillCount(10)).toBe(1);
  });
});

const busy = { type: 'failure', status: 429, data: { message: 'busy', busy: true } };
const lockout = {
  type: 'failure',
  status: 429,
  data: { message: 'too quick', lockoutSeconds: 600 },
};
const ok = { type: 'success' };

describe('createSerialQueue', () => {
  it('starts a post only after the previous one has settled, and keeps their order', async () => {
    const queue = createSerialQueue();
    let running = 0;
    let mostAtOnce = 0;
    const started: number[] = [];
    const post = (n: number, ms: number) =>
      queue.add(async () => {
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        started.push(n);
        await new Promise((done) => setTimeout(done, ms));
        running -= 1;
        return n;
      });

    const results = await Promise.all([post(1, 15), post(2, 1), post(3, 5), post(4, 1)]);

    expect(results).toEqual([1, 2, 3, 4]);
    expect(started).toEqual([1, 2, 3, 4]);
    expect(mostAtOnce).toBe(1);
  });

  it('carries on after a post that failed', async () => {
    const queue = createSerialQueue();
    await expect(queue.add(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(queue.add(async () => 'next')).resolves.toBe('next');
  });
});

describe('sendWithRetry', () => {
  it('sends a busy vote again after a wait, and stops once it succeeds', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(busy)
      .mockResolvedValue(ok);
    const wait = vi.fn(async () => undefined);

    expect(await sendWithRetry(send, wait, [10, 20, 30])).toBe(ok);
    expect(send).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[10], [20]]);
  });

  it('gives up after its last retry and reports the vote as not recorded, without a lockout', async () => {
    const send = vi.fn(async () => busy);
    const result = await sendWithRetry(send, async () => undefined, [1, 1, 1]);

    expect(send).toHaveBeenCalledTimes(4);
    expect(describeOutcome(result)).toEqual({ ok: false, message: 'busy', resync: false });
  });

  it('does not resend a real cooldown, which still asks for the lockout screen', async () => {
    const send = vi.fn(async () => lockout);
    const wait = vi.fn(async () => undefined);
    const result = await sendWithRetry(send, wait);

    expect(send).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(describeOutcome(result)).toMatchObject({ ok: false, resync: true });
  });

  it('does not resend a vote that never reached the server', async () => {
    const send = vi.fn(async () => null);
    expect(await sendWithRetry(send, async () => undefined)).toBeNull();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe('postVote', () => {
  const setup = (sends: (signal: AbortSignal) => Promise<{ reached: boolean; result: any }>) => {
    const tracker = createVoteTracker();
    const failures: unknown[] = [];
    const onSettled = vi.fn(async () => undefined);
    const queue = createSerialQueue();
    const post = (key: string, send = sends) => {
      tracker.claim(key, `t-${key}`);
      return postVote(key, {
        queue,
        tracker,
        send,
        wait: async () => undefined,
        onFailure: (outcome) => failures.push(outcome),
        onSettled,
        timeoutMs: 20,
        retryDelays: [1, 1],
      });
    };
    return { tracker, failures, onSettled, post };
  };
  const hangs = (signal: AbortSignal) =>
    new Promise<{ reached: boolean; result: null }>((done) =>
      signal.addEventListener('abort', () => done({ reached: false, result: null }))
    );

  it('gives up on a hung post, frees its item, and lets the votes queued behind it go out', async () => {
    const sends = [hangs, async () => ({ reached: true, result: ok })];
    const { tracker, failures, post } = setup(async (signal) => sends.shift()!(signal));

    await Promise.all([post('a'), post('b')]);

    expect(tracker.has('a')).toBe(false);
    expect(tracker.has('b')).toBe(true);
    expect(tracker.pending).toBe(0);
    expect(failures).toEqual([
      { ok: false, message: expect.stringMatching(/connection/i), resync: false },
    ]);
  });

  it('marks its own vote settled, so the next stretch stops counting it as in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const { tracker, post } = setup(async () => {
      await gate;
      return { reached: true, result: ok };
    });
    const first = post('a');
    const second = post('b');
    expect(tracker.voting()).toEqual(['t-a', 't-b']);
    release();
    await Promise.all([first, second]);
    expect(tracker.voting()).toEqual([]);
    expect(tracker.has('a')).toBe(true);
  });

  it('never has two posts in flight', async () => {
    let running = 0;
    let most = 0;
    const { post } = setup(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((done) => setTimeout(done, 3));
      running -= 1;
      return { reached: true, result: ok };
    });
    await Promise.all([post('a'), post('b'), post('c')]);
    expect(most).toBe(1);
  });

  it('keeps a recorded vote marked sent and clears the pending count when one fails', async () => {
    const results = [ok, lockout];
    const { tracker, failures, post } = setup(async () => ({
      reached: true,
      result: results.shift(),
    }));

    await Promise.all([post('a'), post('b')]);

    expect(tracker.pending).toBe(0);
    expect(tracker.has('a')).toBe(true);
    expect(failures).toEqual([{ ok: false, message: 'too quick', resync: true }]);
  });

  it('retries a busy vote and records it', async () => {
    const results = [busy, ok];
    const { tracker, failures, post } = setup(async () => ({
      reached: true,
      result: results.shift(),
    }));
    await post('a');
    expect(failures).toEqual([]);
    expect(tracker.has('a')).toBe(true);
  });

  it('frees the item when the vote is still busy after the last resend', async () => {
    const { tracker, failures, post } = setup(async () => ({ reached: true, result: busy }));
    await post('a');
    expect(tracker.has('a')).toBe(false);
    expect(failures).toEqual([{ ok: false, message: 'busy', resync: false }]);
  });

  it('frees the item when a busy vote is followed by a lost connection', async () => {
    const results = [
      { reached: true, result: busy },
      { reached: false, result: null },
    ];
    const { tracker, post } = setup(async () => results.shift()!);
    await post('a');
    expect(tracker.has('a')).toBe(false);
  });

  it('reads the page again once the vote has settled, whatever it came to', async () => {
    const { onSettled, post } = setup(async () => ({ reached: false, result: null }));
    await post('a');
    expect(onSettled).toHaveBeenCalledOnce();
  });
});
