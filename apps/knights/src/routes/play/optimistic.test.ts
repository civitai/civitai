import { describe, expect, it } from 'vitest';
import { MAX_EXCLUDED, createVoteTracker, describeOutcome } from './optimistic';

describe('createVoteTracker', () => {
  it('lets an item be sent once and refuses a second send of the same token', () => {
    const tracker = createVoteTracker();
    expect(tracker.claim('a')).toBe(true);
    expect(tracker.claim('a')).toBe(false);
    expect(tracker.claim('b')).toBe(true);
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
