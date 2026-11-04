import { describe, expect, it } from 'vitest';
import { MAX_EXCLUDED, createItemBuffer, createVoteTracker, describeOutcome } from './optimistic';
import type { PickedItem } from './optimistic';

describe('createVoteTracker', () => {
  it('lets an item be sent once and refuses a second send of the same token', () => {
    const tracker = createVoteTracker();
    expect(tracker.claim('a')).toBe(true);
    expect(tracker.claim('a')).toBe(false);
    expect(tracker.claim('b')).toBe(true);
  });

  it('lets an item be sent again once a vote that never reached the server is released', () => {
    const tracker = createVoteTracker();
    expect(tracker.claim('a')).toBe(true);
    tracker.release('a');
    expect(tracker.claim('a')).toBe(true);
    expect(tracker.excluded('b')).toEqual(['a', 'b']);
  });

  it('counts the votes in flight until each settles, never below zero', () => {
    const tracker = createVoteTracker();
    tracker.claim('a');
    tracker.claim('b');
    expect(tracker.pending).toBe(2);
    tracker.settle();
    tracker.settle();
    tracker.settle();
    expect(tracker.pending).toBe(0);
  });

  it('names the items to leave out of the next stretch: the ones sent and the one on screen, newest last', () => {
    const tracker = createVoteTracker();
    tracker.claim('a');
    tracker.claim('b');
    expect(tracker.excluded('c')).toEqual(['a', 'b', 'c']);
    expect(tracker.excluded('b')).toEqual(['a', 'b']);
  });

  it('keeps only the most recent items, so the query stays small', () => {
    const tracker = createVoteTracker();
    for (const token of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) tracker.claim(token);
    const excluded = tracker.excluded('h');
    expect(excluded).toHaveLength(MAX_EXCLUDED);
    expect(excluded.at(-1)).toBe('h');
    expect(excluded.at(-2)).toBe('g');
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

const picked = (id: string): PickedItem => ({
  question: { key: 'q', kind: 'rating', prompt: 'Rate it', options: [] },
  item: { id, src: `cdn/${id}`, width: 1, height: 1 },
  banner: null,
});
const never = () => false;

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
    expect(buffer.enqueue(picked('b'), (token) => token === 'b')).toBe(false);
    expect(buffer.enqueue(picked('c'), never)).toBe(true);
    expect(buffer.enqueue(picked('d'), never)).toBe(false);
    expect(buffer.tokens()).toEqual(['a', 'c']);
  });

  it('asks for more below the refill size and says how many fill it', () => {
    const buffer = createItemBuffer(3, 2);
    expect(buffer.needsRefill()).toBe(true);
    expect(buffer.missing()).toBe(3);
    buffer.enqueue(picked('a'), never);
    expect(buffer.needsRefill()).toBe(true);
    buffer.enqueue(picked('b'), never);
    expect(buffer.needsRefill()).toBe(false);
    expect(buffer.missing()).toBe(1);
  });

  it('drops one item by token and clears all', () => {
    const buffer = createItemBuffer();
    for (const id of ['a', 'b', 'c']) buffer.enqueue(picked(id), never);
    buffer.drop('b');
    expect(buffer.tokens()).toEqual(['a', 'c']);
    buffer.clear();
    expect(buffer.size).toBe(0);
  });
});
