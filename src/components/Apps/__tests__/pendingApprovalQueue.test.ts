import { describe, expect, it, vi } from 'vitest';
import {
  bindPendingApprovalLifecycle,
  createPendingApprovalQueue,
  isInReviewArea,
  PENDING_APPROVAL_DELAY_MS,
  type QueueTimers,
} from '~/components/Apps/pendingApprovalQueue';

/**
 * The five behaviours the delayed-commit "Approve & next" must have, pinned against the engine
 * with a hand-driven clock (no real time, no browser). Each case names the behaviour it pins.
 *
 * The clock is a tiny manual scheduler rather than `vi.useFakeTimers()` so a case can assert
 * EXACTLY which timers are still armed — "navigation keeps the timer" is a statement about a
 * timer that has not fired, which a global fake clock does not expose directly.
 */

function manualClock() {
  let now = 1_000_000;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: QueueTimers = {
    setTimeout: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      pending.delete(h as number);
    },
    now: () => now,
  };
  return {
    timers,
    armed: () => pending.size,
    /** Advance the clock and fire every timer that came due, in order. */
    async advance(ms: number) {
      now += ms;
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= now)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, t] of due) {
        pending.delete(id);
        t.fn();
      }
      // Let the commit promises settle.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function setup() {
  const clock = manualClock();
  const queue = createPendingApprovalQueue({ timers: clock.timers });
  const commit = vi.fn().mockResolvedValue(undefined);
  return { clock, queue, commit };
}

describe('pending approval queue — the five pinned behaviours', () => {
  it('1. undo within the window sends NOTHING', async () => {
    const { clock, queue, commit } = setup();
    expect(queue.enqueue({ id: 'a', label: 'a v1', commit })).toBe(true);
    await clock.advance(PENDING_APPROVAL_DELAY_MS - 1);
    expect(queue.undo('a')).toBe(true);
    // Well past the original deadline: still nothing sent, and no timer left armed.
    await clock.advance(PENDING_APPROVAL_DELAY_MS * 3);
    expect(commit).not.toHaveBeenCalled();
    expect(clock.armed()).toBe(0);
    expect(queue.get('a')).toBeUndefined();
  });

  it('2. no undo sends EXACTLY once, at the deadline and not before', async () => {
    const { clock, queue, commit } = setup();
    queue.enqueue({ id: 'a', label: 'a v1', commit });
    await clock.advance(PENDING_APPROVAL_DELAY_MS - 1);
    expect(commit).not.toHaveBeenCalled();
    await clock.advance(1);
    expect(commit).toHaveBeenCalledTimes(1);
    await clock.advance(PENDING_APPROVAL_DELAY_MS * 5);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(queue.get('a')?.status).toBe('committed');
    // Undo after the send is refused — there is nothing left to cancel.
    expect(queue.undo('a')).toBe(false);
  });

  it('3. navigation WITHIN the review area keeps the timer (and several can be pending)', async () => {
    const { clock, queue, commit } = setup();
    const handlers: Array<(_url: string) => void> = [];
    const win = new EventTarget() as unknown as Window;
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    }) as unknown as Document;
    bindPendingApprovalLifecycle(queue, {
      routerEvents: { on: (_e, h) => handlers.push(h), off: () => undefined },
      win,
      doc,
    });
    const commitB = vi.fn().mockResolvedValue(undefined);
    queue.enqueue({ id: 'a', label: 'a', commit });
    queue.enqueue({ id: 'b', label: 'b', commit: commitB });
    for (const url of [
      '/apps/review/pubreq_next',
      '/apps/review?tab=pending',
      '/apps/review/preview/pubreq_next',
      '/apps/review/pubreq_other?tab=code#x',
    ]) {
      handlers.forEach((h) => h(url));
    }
    await clock.advance(1);
    expect(commit).not.toHaveBeenCalled();
    expect(commitB).not.toHaveBeenCalled();
    expect(clock.armed()).toBe(2);
    // …and the timers still fire on schedule afterwards.
    await clock.advance(PENDING_APPROVAL_DELAY_MS);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commitB).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a route change outside /apps/review', 'route'],
    ['pagehide', 'pagehide'],
    ['visibilitychange → hidden', 'hidden'],
  ])('4. leaving (%s) commits every pending approval IMMEDIATELY, once', async (_n, how) => {
    const { clock, queue, commit } = setup();
    const handlers: Array<(_url: string) => void> = [];
    const win = new EventTarget() as unknown as Window;
    const docTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const doc = docTarget as unknown as Document;
    bindPendingApprovalLifecycle(queue, {
      routerEvents: { on: (_e, h) => handlers.push(h), off: () => undefined },
      win,
      doc,
    });
    const commitB = vi.fn().mockResolvedValue(undefined);
    queue.enqueue({ id: 'a', label: 'a', commit });
    queue.enqueue({ id: 'b', label: 'b', commit: commitB });

    if (how === 'route') handlers.forEach((h) => h('/models'));
    if (how === 'pagehide') win.dispatchEvent(new Event('pagehide'));
    if (how === 'hidden') {
      docTarget.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    }
    await clock.advance(0);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commitB).toHaveBeenCalledTimes(1);
    expect(clock.armed()).toBe(0);
    // The original timers do not send a second time.
    await clock.advance(PENDING_APPROVAL_DELAY_MS * 2);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commitB).toHaveBeenCalledTimes(1);
  });

  it('4b. a visibilitychange back to VISIBLE commits nothing (positive control for the hidden arm)', async () => {
    const { clock, queue, commit } = setup();
    const win = new EventTarget() as unknown as Window;
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    }) as unknown as Document;
    bindPendingApprovalLifecycle(queue, {
      routerEvents: { on: () => undefined, off: () => undefined },
      win,
      doc,
    });
    queue.enqueue({ id: 'a', label: 'a', commit });
    doc.dispatchEvent(new Event('visibilitychange'));
    await clock.advance(0);
    expect(commit).not.toHaveBeenCalled();
  });

  it('5. a double click cannot approve twice — pending, in flight, or committed', async () => {
    const { clock, queue, commit } = setup();
    expect(queue.enqueue({ id: 'a', label: 'a', commit })).toBe(true);
    // Same id while pending.
    expect(queue.enqueue({ id: 'a', label: 'a', commit })).toBe(false);
    await clock.advance(PENDING_APPROVAL_DELAY_MS);
    // Same id after commit.
    expect(queue.enqueue({ id: 'a', label: 'a', commit })).toBe(false);
    // commitAll after the timer already fired is not a second send either.
    await queue.commitAll();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('5b. an explicit commitAll racing the timer still sends once', async () => {
    const { clock, queue, commit } = setup();
    let resolve!: () => void;
    commit.mockImplementation(() => new Promise<void>((r) => (resolve = r)));
    queue.enqueue({ id: 'a', label: 'a', commit });
    const first = queue.commitAll();
    // In flight: the timer was cleared, and a second commitAll finds nothing pending.
    await queue.commitAll();
    await clock.advance(PENDING_APPROVAL_DELAY_MS);
    resolve();
    await first;
    expect(commit).toHaveBeenCalledTimes(1);
  });
});

describe('pending approval queue — failure and bookkeeping', () => {
  it('a failed commit is reported, released, and can be enqueued again (Retry)', async () => {
    const { clock, queue } = setup();
    const events: string[] = [];
    queue.subscribe((e) => events.push(`${e.type}:${e.entry.id}`));
    const failing = vi.fn().mockRejectedValue(new Error('boom'));
    queue.enqueue({ id: 'a', label: 'a', commit: failing });
    await clock.advance(PENDING_APPROVAL_DELAY_MS);
    expect(events).toEqual(['enqueued:a', 'committing:a', 'failed:a']);
    expect(queue.get('a')).toBeUndefined();
    const ok = vi.fn().mockResolvedValue(undefined);
    expect(queue.enqueue({ id: 'a', label: 'a', commit: ok })).toBe(true);
    await queue.commitNow('a');
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('activeIds lists pending + in-flight ids only; beforeunload warns only while something is pending', async () => {
    const { clock, queue, commit } = setup();
    const win = new EventTarget() as unknown as Window;
    const doc = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    }) as unknown as Document;
    bindPendingApprovalLifecycle(queue, {
      routerEvents: { on: () => undefined, off: () => undefined },
      win,
      doc,
    });
    const fire = () => {
      const e = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
      win.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // Positive control first: nothing pending → no warning.
    expect(fire()).toBe(false);
    queue.enqueue({ id: 'a', label: 'a', commit });
    expect([...queue.activeIds()]).toEqual(['a']);
    expect(fire()).toBe(true);
    await clock.advance(PENDING_APPROVAL_DELAY_MS);
    expect([...queue.activeIds()]).toEqual([]);
    expect(fire()).toBe(false);
  });
});

describe('isInReviewArea', () => {
  it.each([
    ['/apps/review', true],
    ['/apps/review?tab=approved', true],
    ['/apps/review/pubreq_1', true],
    ['/apps/review/preview/pubreq_1', true],
    ['https://example.com/apps/review/pubreq_1', true],
    ['/apps/reviewer', false],
    ['/apps', false],
    ['/models/1', false],
    ['https://example.com/apps/store', false],
  ])('%s → %s', (url, expected) => {
    expect(isInReviewArea(url)).toBe(expected);
  });
});
