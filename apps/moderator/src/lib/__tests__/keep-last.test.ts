import { describe, expect, it } from 'vitest';
import { begin, idle, settle } from '../keep-last';

/**
 * `keepLast` is the app standard's forbidden shape — fetch, then assign to state — allowed in one place
 * because `{#await}` cannot show a previous answer, so paging a list replaced the rows the operator was
 * reading with a spinner and re-filtering took the control they were using with it.
 *
 * The standard forbids the shape because of three failure modes. These pin all three. A revert to the
 * obvious implementation is silent on screen in the common case: everything still loads, and the bug
 * only appears when two requests are in flight or one fails.
 */

const pending = () => begin(idle<string>());

describe('a settled response', () => {
  it('is kept when it is the one that was asked for', () => {
    const s = pending();

    expect(settle(s, s.current, { ok: true, value: 'rows' }).value).toBe('rows');
  });

  it('is DISCARDED when a newer request has already started', () => {
    // The ordering that makes this real: pick type A (slow), pick type B (fast), B lands, then A lands.
    // Without the ticket, A wins because it settled last, and the rows on screen answer a question the
    // controls no longer show — with nothing to indicate it.
    const first = pending();
    const second = begin(first);

    const afterB = settle(second, second.current, { ok: true, value: 'B' });
    const afterLateA = settle(afterB, first.current, { ok: true, value: 'A' });

    expect(afterLateA.value).toBe('B');
  });

  it('does not clear loading when it is stale, because a newer request is still running', () => {
    const first = pending();
    const second = begin(first);

    // The late loser must not report the page as settled — the request the user is waiting on is the
    // one still in flight.
    expect(settle(second, first.current, { ok: true, value: 'A' }).loading).toBe(true);
  });
});

describe('a failure', () => {
  it('clears loading, so no outcome leaves a spinner running', () => {
    const s = pending();

    expect(settle(s, s.current, { ok: false }).loading).toBe(false);
  });

  it('keeps the last good answer rather than blanking it', () => {
    const loaded = settle(pending(), 1, { ok: true, value: 'rows' });
    const refetch = begin(loaded);

    const failed = settle(refetch, refetch.current, { ok: false });

    // Blanking would turn a transient error into apparent absence, and on this page absence is a
    // finding — "this account has no payments" is a conclusion a moderator acts on.
    expect(failed).toMatchObject({ value: 'rows', failed: true });
  });

  it('is cleared by the next attempt, so a recovered request stops reporting an error', () => {
    const failed = settle(pending(), 1, { ok: false });

    expect(begin(failed).failed).toBe(false);
  });
});

describe('starting a request', () => {
  it('leaves the current answer on screen', () => {
    const loaded = settle(pending(), 1, { ok: true, value: 'rows' });

    // The whole point: "Load 200 more" must not replace what is already there.
    expect(begin(loaded)).toMatchObject({ value: 'rows', loading: true });
  });

  it('takes a ticket nothing earlier can hold', () => {
    const a = pending();
    const b = begin(a);
    const c = begin(b);

    expect(new Set([a.current, b.current, c.current]).size).toBe(3);
  });
});
