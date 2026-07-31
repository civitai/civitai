import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { cleanup } from 'vitest-browser-react';
import { renderWithProviders } from '../../../test/component-setup';
import { useBlockToken } from '~/components/AppBlocks/useBlockToken';
import {
  MAX_REFRESH_RETRIES,
  REFRESH_RETRY_BACKOFF_MS,
} from '~/components/AppBlocks/blockTokenRetry';
import type { BlockInstall, SlotContext } from '~/components/AppBlocks/types';

/**
 * `useBlockToken` MID-SESSION REFRESH-FAILURE RECOVERY.
 *
 * 🔴 THE DEFECT THIS SUITE EXISTS FOR. A refresh that failed set `error`, nulled
 * the token, and scheduled NOTHING — the success path was the only place a timer
 * was ever armed. The sole route back was the user hiding and re-showing the tab.
 * Downstream that read as the model-slot block VANISHING mid-session (taking
 * in-progress state with it, then remounting and double-counting its impression),
 * or the page host silently sitting on a dead token while the block 401'd.
 *
 * 🔴 THIS SUITE EXERCISES THE REAL PATH — that is its whole point. It renders the
 * REAL hook with real React, real state, and the real timer machinery (only the
 * CLOCK is faked, via `shouldAdvanceTime` so DOM polling still works). The ONLY
 * thing stubbed is `fetch` — the network boundary, i.e. the failure being
 * injected — never the hook, never the decision functions, never a timer wrapper.
 * Stubbing any of those would make the fiber quiescent and hide exactly the
 * batching/ordering behaviour these assertions depend on.
 *
 * The bounds themselves get exhaustive cheap coverage in the node-env
 * `__tests__/blockTokenRetry.test.ts`; here we prove the hook APPLIES them.
 */

const INSTANCE_ID = 'bki_test_instance';

// The hook reads only `install.blockInstanceId` and forwards `context` verbatim.
const install = { blockInstanceId: INSTANCE_ID } as unknown as BlockInstall;
const context = { slotId: 'model.sidebar_top', modelId: 123 } as unknown as SlotContext;

/** A token whose refresh (T-2min) lands well before expiry, so a failure at the
 *  refresh moment still leaves a comfortably-live credential to retain. */
const TOKEN_TTL_MS = 15 * 60_000;
const REFRESH_AT_MS = TOKEN_TTL_MS - 2 * 60_000; // REFRESH_LEAD_MS

let mintCount = 0;

function mintOk(nth: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      token: `tok_${nth}`,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      needsConsent: false,
      missingScopes: [],
      domain: 'blue',
      maxBrowsingLevel: 3,
    }),
  } as unknown as Response;
}
const mintFail = { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
const mint429 = { ok: false, status: 429, json: async () => ({}) } as unknown as Response;

/** Surfaces the hook's returned contract as observable DOM attributes. */
function TokenProbe() {
  const r = useBlockToken(install, context);
  return (
    <div
      data-testid="probe"
      data-token={r.token ?? ''}
      data-pending={String(r.pending)}
      data-error={r.error ? 'true' : 'false'}
      data-retrying={String(r.retrying)}
      data-terminal={String(r.terminal)}
    />
  );
}

// React 18 commits ASYNCHRONOUSLY, so the probe is absent for the first few
// ticks after render — every reader must tolerate that rather than throw.
const probe = () => document.querySelector('[data-testid="probe"]') as HTMLElement | null;
const attr = (name: string) => probe()?.getAttribute(name) ?? null;
const readToken = () => attr('data-token');
const readRetrying = () => attr('data-retrying') === 'true';
const readTerminal = () => attr('data-terminal') === 'true';
const readError = () => attr('data-error') === 'true';

/** Advance the fake clock and let React flush the resulting state updates. */
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  // Extra zero-length turns: the fetch promise chain resolves across several
  // microtask ticks before React schedules and commits.
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
}

async function waitForToken(expected: string) {
  for (let i = 0; i < 200; i++) {
    if (readToken() === expected) return;
    await advance(1);
  }
  throw new Error(`token never became ${expected}; last=${String(readToken())}`);
}

let fetchSpy: ReturnType<typeof vi.fn>;
/** Fake-clock instant of every mint request, so the tests can assert the SHAPE
 *  of the request pattern (e.g. that a 60s pause really elapsed) rather than
 *  just counting calls. */
let callTimes: number[] = [];

beforeEach(() => {
  mintCount = 0;
  callTimes = [];
  // `shouldAdvanceTime` keeps real time moving so DOM polling can't deadlock.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchSpy = vi.fn(async () => {
    callTimes.push(Date.now());
    return mintOk(++mintCount);
  });
  vi.stubGlobal('fetch', fetchSpy);
});

/** Swap the mint outcome while keeping the call-time recording. */
function respondWith(next: () => Response) {
  fetchSpy.mockImplementation(async () => {
    callTimes.push(Date.now());
    return next();
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('refresh failure at a healthy session', () => {
  test('🔴 KEEPS the still-live token and SCHEDULES a bounded retry (was: null + nothing)', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');
    expect(readRetrying()).toBe(false);

    // The scheduled refresh at T-2min now fails.
    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);

    expect(readError()).toBe(true);
    // (1) The credential we already hold is NOT destroyed. This is what keeps the
    //     iframe mounted — the whole model-slot vanish/remount/double-beacon class.
    expect(readToken()).toBe('tok_1');
    // (2) A retry IS pending. Pre-fix this was false forever: nothing was armed.
    expect(readRetrying()).toBe(true);
    // (3) Not terminal — recovery is still under way, so no consumer may collapse.
    expect(readTerminal()).toBe(false);
  });

  test('recovers on a later attempt: the token ROTATES and the state clears', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');

    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    expect(readRetrying()).toBe(true);
    expect(readToken()).toBe('tok_1');

    // First backoff attempt fails too…
    await advance(REFRESH_RETRY_BACKOFF_MS[0] + 5);
    expect(readToken()).toBe('tok_1'); // still retained
    expect(readRetrying()).toBe(true);

    // …the second succeeds.
    respondWith(() => mintOk(++mintCount));
    await advance(REFRESH_RETRY_BACKOFF_MS[1] + 5);

    await waitForToken('tok_2');
    expect(readRetrying()).toBe(false);
    expect(readTerminal()).toBe(false);
    expect(readError()).toBe(false);
  });

  test('a SUCCESS refills the retry budget for the next episode', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');

    // Episode 1: fail once, then recover.
    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    respondWith(() => mintOk(++mintCount));
    await advance(REFRESH_RETRY_BACKOFF_MS[0] + 5);
    await waitForToken('tok_2');

    // Episode 2 must get the FULL budget again, not the remainder of the first.
    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    let scheduled = 0;
    for (let i = 0; i < MAX_REFRESH_RETRIES; i++) {
      if (readRetrying()) scheduled++;
      await advance(REFRESH_RETRY_BACKOFF_MS[i] + 5);
    }
    expect(scheduled).toBe(MAX_REFRESH_RETRIES);
  });
});

describe('exhaustion — bounded, then SETTLE', () => {
  test('🔴 stops after MAX_REFRESH_RETRIES and never retries again on its own', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');

    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    const afterFirstFailure = fetchSpy.mock.calls.length;

    for (let i = 0; i < MAX_REFRESH_RETRIES; i++) {
      expect(readRetrying()).toBe(true);
      await advance(REFRESH_RETRY_BACKOFF_MS[i] + 5);
    }

    // Settled: no further automatic attempt.
    expect(readRetrying()).toBe(false);
    const afterExhaustion = fetchSpy.mock.calls.length;
    expect(afterExhaustion - afterFirstFailure).toBe(MAX_REFRESH_RETRIES);

    // 🔴 NOT MASKED BY INDEFINITE RETRYING: a long wait issues nothing more.
    await advance(10 * 60_000);
    expect(fetchSpy.mock.calls.length).toBe(afterExhaustion);
    expect(readRetrying()).toBe(false);
  });

  test('the retained token is swept at its real expiry, so `terminal` becomes TRUE', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');

    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    for (let i = 0; i < MAX_REFRESH_RETRIES; i++) {
      await advance(REFRESH_RETRY_BACKOFF_MS[i] + 5);
    }

    // Settled, but the held token is still live → the app keeps working and the
    // host must NOT be told the session is over yet.
    expect(readToken()).toBe('tok_1');
    expect(readTerminal()).toBe(false);

    // 🔴 The loose end the sweep closes: without it the hook would hold this token
    // past expiry forever and the block would quietly 401 — the exact page-host
    // half of the reported defect, reintroduced.
    await advance(TOKEN_TTL_MS);
    expect(readToken()).toBe('');
    expect(readTerminal()).toBe(true);
  });
});

describe('HTTP 429 — the existing jittered pause is respected, not aborted', () => {
  test('🔴 no automatic caller interrupts the in-band 60s backoff (no retry storm)', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');

    // Every mint now rate-limits. `fetchOnce` handles the FIRST 429 by sleeping
    // ~60s (jittered +/-15s) before its single in-band retry.
    respondWith(() => mint429);
    // Step to just past the refresh moment so we are provably INSIDE that pause.
    await advance(REFRESH_AT_MS - 5_000);
    await advance(6_000);
    const rateLimitedAt = callTimes[callTimes.length - 1];
    const duringPause = fetchSpy.mock.calls.length;
    expect(duringPause).toBe(2); // initial mint + the 429'd refresh

    // Mid-pause, drive BOTH automatic entry points that could preempt it.
    // 🔴 Pre-guard, either would abort the controller and immediately re-hit the
    // endpoint that had JUST told us to back off — turning a platform-wide
    // rate-limit event into a self-inflicted storm.
    for (let i = 0; i < 4; i++) {
      document.dispatchEvent(new Event('visibilitychange'));
      await advance(5_000);
      expect(fetchSpy.mock.calls.length).toBe(duringPause);
    }

    // Let the pause elapse. The next request must be the hook's OWN in-band
    // retry, and it must land a full backoff later — that gap IS the invariant.
    await advance(80_000);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(duringPause);
    const resumedAt = callTimes[duringPause];
    expect(resumedAt - rateLimitedAt).toBeGreaterThanOrEqual(
      // 60s base minus the full -15s jitter.
      45_000
    );
  });

  test('a sustained 429 outage stays far under the 60/min endpoint budget', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');
    const before = fetchSpy.mock.calls.length;

    respondWith(() => mint429);
    await advance(REFRESH_AT_MS);
    // Run the whole budget out, generously past every pause + backoff.
    for (let i = 0; i < MAX_REFRESH_RETRIES; i++) {
      await advance(80_000 + REFRESH_RETRY_BACKOFF_MS[i]);
    }
    await advance(5 * 60_000);

    const issued = fetchSpy.mock.calls.length - before;
    // (1 + MAX_REFRESH_RETRIES) episodes x at most 2 requests each.
    expect(issued).toBeLessThanOrEqual(2 * (MAX_REFRESH_RETRIES + 1));
    expect(readRetrying()).toBe(false);
  });
});

describe('visibilitychange recovery', () => {
  test('🔴 does NOT double-fire alongside a pending backoff timer', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');

    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    const afterFailure = fetchSpy.mock.calls.length;
    expect(readRetrying()).toBe(true);

    // Inside the backoff window the armed timer is the single attempt: the
    // visibility handler must stand down (it now shares `refreshAtRef`).
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(REFRESH_RETRY_BACKOFF_MS[0] / 4);
    expect(fetchSpy.mock.calls.length).toBe(afterFailure);

    // The timer — and only the timer — produces the next attempt.
    await advance(REFRESH_RETRY_BACKOFF_MS[0]);
    expect(fetchSpy.mock.calls.length).toBe(afterFailure + 1);
  });

  test('STILL WORKS as the escape hatch once automatic recovery has settled', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');

    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    for (let i = 0; i < MAX_REFRESH_RETRIES; i++) {
      await advance(REFRESH_RETRY_BACKOFF_MS[i] + 5);
    }
    expect(readRetrying()).toBe(false);
    const settled = fetchSpy.mock.calls.length;

    // The user backgrounds and returns; the outage has cleared.
    respondWith(() => mintOk(++mintCount));
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(50);

    expect(fetchSpy.mock.calls.length).toBe(settled + 1);
    await waitForToken('tok_2');
    expect(readTerminal()).toBe(false);
    expect(readError()).toBe(false);
  });
});

describe('lifecycle', () => {
  test('🔴 NO TIMER LEAK: unmounting mid-backoff fires nothing', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');

    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    expect(readRetrying()).toBe(true);
    const atUnmount = fetchSpy.mock.calls.length;
    // 🔴 A pending backoff timer really is armed right now — otherwise the
    // assertion below would be vacuous.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // `cleanup()` unmounts the tree — vitest-browser-react's render result has no
    // `unmount`. This runs the hook's effect teardown, i.e. the real code path.
    await cleanup();

    // 🔴 ASSERT THE TIMER ITSELF IS GONE, not merely that no request followed.
    // The first version of this test only checked the request count and SURVIVED
    // a mutation that deleted the cleanup's clearTimeout — because the callback's
    // own `!mountedRef.current` guard suppresses the fetch anyway. That guard
    // makes the leak HARMLESS, not absent: the timer still fires and, for the
    // expiry sweep, keeps a closure alive for up to a full token lifetime.
    expect(vi.getTimerCount()).toBe(0);

    // Well past every remaining backoff AND the token's expiry sweep.
    await vi.advanceTimersByTimeAsync(TOKEN_TTL_MS + 60_000);
    expect(fetchSpy.mock.calls.length).toBe(atUnmount);
  });

  test('🔴 NO TIMER LEAK: unmounting while the expiry sweep is armed fires nothing', async () => {
    renderWithProviders(<TokenProbe />);
    await waitForToken('tok_1');

    respondWith(() => mintFail);
    await advance(REFRESH_AT_MS);
    for (let i = 0; i < MAX_REFRESH_RETRIES; i++) {
      await advance(REFRESH_RETRY_BACKOFF_MS[i] + 5);
    }
    const atUnmount = fetchSpy.mock.calls.length;
    // The settled state arms a one-shot sweep at the token's expiry — up to a
    // full token lifetime away, so this is the longest-lived timer of the lot.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await cleanup();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(TOKEN_TTL_MS + 60_000);
    expect(fetchSpy.mock.calls.length).toBe(atUnmount);
  });
});
