import { describe, expect, it } from 'vitest';
import {
  BUFFER_TARGET,
  MAX_EXCLUDED,
  createItemBuffer,
  createVoteTracker,
  describeOutcome,
  itemKey,
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

  it('keeps only the most recent items, so the query stays small', () => {
    const tracker = createVoteTracker();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) tracker.claim(`k${id}`, `t${id}`);
    const excluded = tracker.excluded('th');
    expect(excluded).toHaveLength(MAX_EXCLUDED);
    expect(excluded.at(-1)).toBe('th');
    expect(excluded.at(-2)).toBe('tg');
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
  it('hands items out in the order they were enqueued', () => {
    const buffer = createItemBuffer();
    buffer.enqueue(picked('a'), never);
    buffer.enqueue(picked('b'), never);
    expect(buffer.peek()?.item.id).toBe('a');
    expect(buffer.next()?.item.id).toBe('a');
    expect(buffer.next()?.item.id).toBe('b');
    expect(buffer.next()).toBeNull();
  });

  it('refuses a repeat, an item the caller already knows, and anything past the target', () => {
    const buffer = createItemBuffer(2);
    expect(buffer.enqueue(picked('a'), never)).toBe(true);
    expect(buffer.enqueue(picked('a'), never)).toBe(false);
    expect(buffer.enqueue(picked('b'), (key) => key === 'b')).toBe(false);
    expect(buffer.enqueue(picked('c'), never)).toBe(true);
    expect(buffer.enqueue(picked('d'), never)).toBe(false);
    expect(buffer.tokens()).toEqual(['a', 'c']);
  });

  it('treats the same key under a different token as a repeat', () => {
    const buffer = createItemBuffer();
    expect(buffer.enqueue(picked('token-1', 'same'), never)).toBe(true);
    expect(buffer.enqueue(picked('token-2', 'same'), never)).toBe(false);
    expect(buffer.enqueue(picked('token-3', 'sent'), (key) => key === 'sent')).toBe(false);
    expect(buffer.tokens()).toEqual(['token-1']);
  });

  it('asks for more as soon as it is below the target and says how many fill it', () => {
    const buffer = createItemBuffer();
    expect(BUFFER_TARGET).toBe(3);
    expect(buffer.needsRefill()).toBe(true);
    expect(buffer.missing()).toBe(3);
    buffer.enqueue(picked('a'), never);
    buffer.enqueue(picked('b'), never);
    expect(buffer.needsRefill()).toBe(true);
    expect(buffer.missing()).toBe(1);
    buffer.enqueue(picked('c'), never);
    expect(buffer.needsRefill()).toBe(false);
    expect(buffer.missing()).toBe(0);
  });

  it('drops one item by key and clears all', () => {
    const buffer = createItemBuffer();
    for (const id of ['a', 'b', 'c']) buffer.enqueue(picked(`t${id}`, id), never);
    buffer.drop('b');
    expect(buffer.tokens()).toEqual(['ta', 'tc']);
    buffer.clear();
    expect(buffer.size).toBe(0);
  });
});
