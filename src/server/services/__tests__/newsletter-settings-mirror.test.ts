import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `updateSubscription` writes Beehiiv FIRST and mirrors the result into
 * `User.settings.newsletterSubscriber` second. That second write used to be
 * un-awaited and uncaught:
 *
 *   await beehiiv.setSubscription({ email, subscribed });
 *   if (userId) setUserSetting(userId, { newsletterSubscriber: subscribed });
 *
 * which was harmless only while `setUserSetting` could not fail: it was a bare
 * `$executeRaw` that silently no-op'd when the row did not exist. It now throws
 * NOT_FOUND on a zero-row update, so that line became a source of UNHANDLED
 * PROMISE REJECTIONS — invisible to the mutation's own control flow, and to any
 * test that only asserts the mutation resolves.
 *
 * The two things this suite pins are the two halves of that fix, and they have to
 * be pinned SEPARATELY because either one alone still lets the mutation resolve:
 *
 *   1. the settings write is AWAITED — it finishes inside the request rather than
 *      racing the response (this is what makes the unhandled-rejection shape
 *      impossible rather than merely handled); and
 *   2. its failure is CAUGHT and LOGGED, and does NOT fail the mutation — because
 *      Beehiiv, the system of record, has already committed by then.
 *
 * A test asserting only "updateSubscription resolves" would be vacuous: it passes
 * on the pre-change code too.
 */

const setUserSetting = vi.fn();
const setSubscription = vi.fn();
const logToAxiom = vi.fn(() => Promise.resolve());

vi.mock('~/server/services/user.service', () => ({
  setUserSetting: (...args: unknown[]) => setUserSetting(...args),
}));

vi.mock('~/server/integrations/beehiiv', () => ({
  beehiiv: {
    setSubscription: (...args: unknown[]) => setSubscription(...args),
    getSubscription: vi.fn(),
  },
}));

vi.mock('~/server/db/client', () => ({
  dbRead: { user: { findFirst: vi.fn() } },
}));

vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => logToAxiom(...args),
  safeError: (error: unknown) => ({ message: (error as Error)?.message }),
}));

import { updateSubscription } from '~/server/services/newsletter.service';

const ARGS = { email: 'someone@example.com', userId: 7, subscribed: true };

/** A promise whose settlement this test controls, so ordering is asserted, not timed. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-queued microtask run, without introducing a timing dependency. */
const drainMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  setUserSetting.mockReset();
  setSubscription.mockReset();
  logToAxiom.mockReset();
  setSubscription.mockResolvedValue(undefined);
  setUserSetting.mockResolvedValue({});
  logToAxiom.mockResolvedValue(undefined);
});

describe('updateSubscription — the settings mirror write', () => {
  it('does not resolve until the settings write has settled', async () => {
    const gate = deferred();
    setUserSetting.mockReturnValue(gate.promise);

    let settled = false;
    const call = updateSubscription({ ...ARGS }).then(() => {
      settled = true;
    });

    await drainMicrotasks();
    // Pre-change (un-awaited) this is already true: the mutation returned while the
    // write was still in flight, which is exactly how its rejection escaped.
    expect(settled).toBe(false);
    expect(setUserSetting).toHaveBeenCalledTimes(1);

    gate.resolve();
    await call;
    expect(settled).toBe(true);
  });

  it('a REJECTING settings write is logged and does not fail the mutation', async () => {
    setUserSetting.mockRejectedValue(new Error('No user with id 7'));

    await expect(updateSubscription({ ...ARGS })).resolves.toBeUndefined();

    expect(logToAxiom).toHaveBeenCalledTimes(1);
    const [payload] = logToAxiom.mock.calls[0] as [Record<string, unknown>];
    expect(payload.type).toBe('newsletter.settings-mirror.failed');
    expect(payload.error).toEqual({ message: 'No user with id 7' });
    // The Beehiiv side already committed and must NOT be retried or rolled back by
    // the mirror's failure.
    expect(setSubscription).toHaveBeenCalledTimes(1);
  });

  it('logs NOTHING when the settings write succeeds (negative control)', async () => {
    await expect(updateSubscription({ ...ARGS })).resolves.toBeUndefined();

    expect(setUserSetting).toHaveBeenCalledWith(7, { newsletterSubscriber: true });
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('a failing BEEHIIV call still throws — only the mirror is best-effort', async () => {
    setSubscription.mockRejectedValue(new Error('beehiiv 500'));

    await expect(updateSubscription({ ...ARGS })).rejects.toThrow('beehiiv 500');

    // Nothing to mirror if the source of truth never changed.
    expect(setUserSetting).not.toHaveBeenCalled();
    expect(logToAxiom).not.toHaveBeenCalled();
  });

  it('writes no settings at all when there is no userId', async () => {
    await expect(updateSubscription({ email: ARGS.email, subscribed: false })).resolves.toBe(
      undefined
    );

    expect(setSubscription).toHaveBeenCalledTimes(1);
    expect(setUserSetting).not.toHaveBeenCalled();
  });
});
