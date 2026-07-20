import { describe, expect, it, vi } from 'vitest';

/**
 * MOD REVIEW SANDBOX (#2831) — waitForReviewHostReachable.
 *
 * The review preview's per-host DNS record can lag the deploy by up to ~a
 * minute; the callback gates "preview-live" on this probe so a mod never clicks
 * through to ERR_NAME_NOT_RESOLVED. These tests pin the reachability contract:
 *   - ANY HTTP response (any status) → reachable (true), no auth attempted.
 *   - a thrown fetch (DNS not-found / refused / per-attempt timeout) → retry.
 *   - every attempt throwing until the budget elapses → false.
 * A fake clock drives the timeout so there's no real network or wall-clock wait.
 */

// The helper's DEFAULT timeout reads from env.REVIEW_HOST_REACHABLE_TIMEOUT_MS
// (180s in the real schema). Provide it so the default path has a finite budget.
vi.mock('~/env/server', () => ({ env: { REVIEW_HOST_REACHABLE_TIMEOUT_MS: 180_000 } }));

import { waitForReviewHostReachable } from '~/server/services/blocks/apps-pipeline.service';

const HOST = 'review-abc123def4567890.civit.ai';

// A monotonic fake clock: sleep(ms) advances `t` by ms so the loop's deadline
// check terminates deterministically without a real timer.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

// Never schedule a real per-attempt AbortSignal timer in tests.
const noSignal = () => undefined;

describe('waitForReviewHostReachable', () => {
  it('returns true on the first HTTP response (a 200)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    // Probed the public host over HTTPS with a HEAD + manual redirect.
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://${HOST}/`);
    expect(init.method).toBe('HEAD');
    expect(init.redirect).toBe('manual');
  });

  it('treats a 403 (mod-gate forward-auth) as reachable — any status counts, no auth', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // No Authorization header — we never authenticate through the gate.
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string> | undefined) ?? {}).not.toHaveProperty(
      'Authorization'
    );
  });

  it('treats a 3xx redirect as reachable', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 302 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
  });

  it('retries when the first attempt throws ENOTFOUND, then succeeds', async () => {
    const enotfound = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(enotfound)
      .mockResolvedValueOnce(new Response('', { status: 401 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 120_000,
      intervalMs: 4_000,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(clock.sleep).toHaveBeenCalledTimes(1);
    expect(clock.sleep).toHaveBeenCalledWith(4_000);
  });

  it('returns false when every attempt throws until the timeout elapses', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 120_000,
      intervalMs: 4_000,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(false);
    // now advances 0,4000,…; the post-sleep deadline check trips once now hits
    // 120000 (after the 30th sleep), so we make 30 attempts + 30 sleeps and
    // short-circuit before a pointless 31st fetch.
    expect(fetchImpl).toHaveBeenCalledTimes(30);
    expect(clock.sleep).toHaveBeenCalledTimes(30);
  });

  it('defaults the overall budget to env.REVIEW_HOST_REACHABLE_TIMEOUT_MS (env-tunable)', async () => {
    // env mock supplies 180_000; with a 4s interval that's 45 sleeps before the
    // deadline trips (180000/4000). Proves the default is env-driven, not a
    // hard-coded literal — so ops can raise it without a code change.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      // no timeoutMs → falls back to env default (180s)
      intervalMs: 4_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(false);
    expect(clock.sleep).toHaveBeenCalledTimes(45);
    expect(fetchImpl).toHaveBeenCalledTimes(45);
  });

  it('treats a per-attempt timeout (thrown AbortError) as not-ready, not reachable', async () => {
    // One aborted attempt then a real response → still resolves true after retry,
    // proving a hung/aborted attempt is "not ready", never "reachable".
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abort)
      .mockResolvedValueOnce(new Response('', { status: 200 }));
    const clock = fakeClock();
    const ok = await waitForReviewHostReachable(HOST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: clock.now,
      sleep: clock.sleep,
      signalFactory: noSignal,
    });
    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
