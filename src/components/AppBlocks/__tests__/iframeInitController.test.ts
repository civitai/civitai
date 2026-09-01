import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IframeInitController,
  INIT_RETRY_BACKOFF_MS,
  INIT_RETRY_INTERVAL_MS,
  initRetryDelayMs,
  maxInitPostsWithin,
} from '../iframeInitController';

/**
 * Regression coverage for the prod App-Blocks "blank iframe" bug.
 *
 * THE BUG: the host posted BLOCK_INIT exactly once, gated on the iframe's
 * React `onLoad` having fired. On prod the block bundle (`<slug>.civit.ai`) is
 * cached, so the iframe `load` event fires BEFORE React attaches `onLoad` →
 * the event is missed → init was never posted → the block's transport rejected
 * with "timed out waiting for BLOCK_INIT after 10000ms" and the iframe stayed
 * blank forever. Critically, the readiness timeout was ALSO gated on
 * `iframeLoaded`, so nothing surfaced a fallback — a silent indefinite
 * skeleton.
 *
 * THE FIX (this controller): once init is allowed (token + checkpoint ready)
 * the host hands control here. We post BLOCK_INIT immediately, re-post on a
 * short interval until the block acks (BLOCK_READY → notifyReady), and arm the
 * readiness timeout on start() — NOT on any load event. Repeated posts are
 * safe: the block's IframeTransport origin-checks and dedupes BLOCK_INIT
 * (`if (!this.initResolved)`).
 *
 * These tests drive the controller with fake timers. They are the unit that
 * the old load-gated code could not satisfy: the old path required an `onLoad`
 * event to fire before it would ever post init OR arm a timeout; this
 * controller does both with no load signal at all.
 */
describe('IframeInitController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeController(overrides?: {
    sendInit?: () => void;
    onReadyTimeout?: () => void;
    readyTimeoutMs?: number;
    retryIntervalMs?: number;
    retryBackoffMs?: readonly number[];
  }) {
    const sendInit = overrides?.sendInit ?? vi.fn();
    const onReadyTimeout = overrides?.onReadyTimeout ?? vi.fn();
    const controller = new IframeInitController({
      sendInit,
      onReadyTimeout,
      readyTimeoutMs: overrides?.readyTimeoutMs ?? 10_000,
      retryIntervalMs: overrides?.retryIntervalMs,
      retryBackoffMs: overrides?.retryBackoffMs,
    });
    return { controller, sendInit, onReadyTimeout };
  }

  /**
   * Advance the fake clock past re-post number `n` (1-indexed; `n = 1` is the
   * first re-post AFTER the immediate post `start()` makes), returning the
   * absolute offset reached.
   *
   * 🔴 DRIVEN BY THE EXPORTED SCHEDULE, NOT A LITERAL. If this re-implemented
   * `backoff[i] ?? steady` it would agree with a broken change by construction
   * — the classic "expectation derived from the implementation" tautology. It
   * calls the shipped `initRetryDelayMs`, so a change to the schedule moves
   * BOTH the code and this helper, and the OFFSET assertions below (which are
   * literals) are what actually pin the values.
   */
  function advanceThroughReposts(n: number): number {
    let elapsed = 0;
    for (let i = 0; i < n; i += 1) {
      const step = initRetryDelayMs(i);
      elapsed += step;
      vi.advanceTimersByTime(step);
    }
    return elapsed;
  }

  describe('the race: init does not depend on the iframe load event', () => {
    it('posts BLOCK_INIT immediately on start(), with no load signal', () => {
      const { controller, sendInit } = makeController();
      // No `onLoad` is ever simulated — the controller has no concept of it.
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1);
    });

    it('keeps re-posting BLOCK_INIT until acked, settling at the steady interval', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1); // immediate

      // Past the front-loaded backoff.
      advanceThroughReposts(INIT_RETRY_BACKOFF_MS.length);
      expect(sendInit).toHaveBeenCalledTimes(1 + INIT_RETRY_BACKOFF_MS.length);

      // Several more ticks — still re-sending because no BLOCK_READY arrived,
      // now on the flat steady period.
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS * 3);
      expect(sendInit).toHaveBeenCalledTimes(1 + INIT_RETRY_BACKOFF_MS.length + 3);
    });

    /**
     * 🔴 THE LEVER, PINNED AS ABSOLUTE OFFSETS — the point of this whole change.
     *
     * Deliberately LITERAL milliseconds rather than a loop over the exported
     * schedule. A test that walks the same array the code walks is green for any
     * array, so it could not tell a shortened schedule from an unchanged one —
     * and "did the front of the schedule actually get shorter" is the only
     * question this PR's first deliverable is about. These numbers are the
     * schedule; changing it must fail here and be re-justified.
     */
    it('🔴 posts land at 0 / 50 / 150 / 350 ms, then every 400 ms', () => {
      const { controller, sendInit } = makeController();
      const at = (): number => sendInit.mock.calls.length;

      controller.start();
      expect(at()).toBe(1); // t = 0

      vi.advanceTimersByTime(49);
      expect(at()).toBe(1); // nothing yet at t = 49
      vi.advanceTimersByTime(1);
      expect(at()).toBe(2); // t = 50

      vi.advanceTimersByTime(99);
      expect(at()).toBe(2); // t = 149
      vi.advanceTimersByTime(1);
      expect(at()).toBe(3); // t = 150

      vi.advanceTimersByTime(199);
      expect(at()).toBe(3); // t = 349
      vi.advanceTimersByTime(1);
      expect(at()).toBe(4); // t = 350

      // Settled: the next gap is the steady 400, not another backoff step.
      vi.advanceTimersByTime(399);
      expect(at()).toBe(4); // t = 749
      vi.advanceTimersByTime(1);
      expect(at()).toBe(5); // t = 750
      vi.advanceTimersByTime(400);
      expect(at()).toBe(6); // t = 1150
    });

    /**
     * 🔴 THE MEASURED CLAIM THIS CHANGE RESTS ON, expressed as an assertion.
     *
     * `init_wait`'s 0.4-0.6s mode is consistent with re-post quantization: a
     * block whose listener attaches early still waited out the rest of a 400ms
     * tick. Under the OLD flat schedule the second post did not land until
     * t=400, so nothing in 0-400ms could be re-asked. Under the new one a block
     * that attaches at, say, t=120 is re-asked at 150 instead of 400.
     *
     * This is the property, not a claim about production: three posts now land
     * inside the first 400ms where previously there was exactly one.
     */
    it('🔴 fits 4 posts in the window the flat 400ms schedule fit 1 into', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS - 1); // t = 399
      expect(sendInit).toHaveBeenCalledTimes(4);
      // The old flat schedule's first re-post instant is now the FOURTH gap's,
      // i.e. strictly later than three earlier chances to be heard.
      expect(maxInitPostsWithin(INIT_RETRY_INTERVAL_MS, [], INIT_RETRY_INTERVAL_MS)).toBe(1);
      expect(maxInitPostsWithin(INIT_RETRY_INTERVAL_MS)).toBe(4);
    });

    it('uses the configurable steady interval once the backoff is exhausted', () => {
      const { controller, sendInit } = makeController({ retryIntervalMs: 250 });
      controller.start();
      advanceThroughReposts(INIT_RETRY_BACKOFF_MS.length);
      const settled = sendInit.mock.calls.length;
      vi.advanceTimersByTime(249);
      expect(sendInit).toHaveBeenCalledTimes(settled);
      vi.advanceTimersByTime(1);
      expect(sendInit).toHaveBeenCalledTimes(settled + 1);
    });

    it('accepts an explicit flat schedule (retryBackoffMs: []) — the pre-change cadence', () => {
      const { controller, sendInit } = makeController({ retryBackoffMs: [] });
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS - 1);
      expect(sendInit).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(sendInit).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * `maxInitPostsWithin` is what DERIVES the `initPosts` sample cap
   * (`worstReachableInitPosts` -> `MAX_LAUNCH_INIT_POSTS`), so a wrong value
   * there silently drops real samples off the top of the histogram. It is also
   * pure, so it can be pinned against the controller's own observed behaviour
   * rather than against a re-implementation.
   */
  describe('maxInitPostsWithin: the derivation behind the initPosts cap', () => {
    it('agrees with what the controller actually posts in the same window', () => {
      const window = 10_000;
      const { controller, sendInit } = makeController({ readyTimeoutMs: window });
      controller.start();
      vi.advanceTimersByTime(window);
      // The readiness timeout at exactly `window` stops the loop, so a re-post
      // due at the same instant does not land — the arithmetic must use the same
      // strict bound the controller does.
      expect(sendInit).toHaveBeenCalledTimes(maxInitPostsWithin(window));
      expect(controller.postCount()).toBe(maxInitPostsWithin(window));
    });

    it('counts the immediate post, and nothing at a non-positive window', () => {
      expect(maxInitPostsWithin(1)).toBe(1);
      expect(maxInitPostsWithin(0)).toBe(0);
      expect(maxInitPostsWithin(-5)).toBe(0);
    });

    it('a SHORTER schedule yields MORE posts in a fixed window (the direction that matters)', () => {
      // If this inverted, the cap derived from it would be too small and would
      // drop exactly the high-post-count launches the metric exists to find.
      expect(maxInitPostsWithin(10_000, [50, 100, 200], 400)).toBeGreaterThan(
        maxInitPostsWithin(10_000, [], 400)
      );
    });
  });

  describe('retry stops once the block acks (BLOCK_READY → notifyReady)', () => {
    it('stops re-posting after notifyReady()', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      advanceThroughReposts(2);
      expect(sendInit).toHaveBeenCalledTimes(3);

      controller.notifyReady();

      // No further sends, ever — including through the rest of the backoff and
      // well past the point the steady interval takes over.
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS * 10);
      expect(sendInit).toHaveBeenCalledTimes(3);
      expect(controller.postCount()).toBe(3);
    });

    it('does not fire the readiness timeout after acking', () => {
      const { controller, sendInit, onReadyTimeout } = makeController({
        readyTimeoutMs: 10_000,
      });
      controller.start();
      controller.notifyReady();
      vi.advanceTimersByTime(20_000);
      expect(onReadyTimeout).not.toHaveBeenCalled();
      // and no retry sends leaked through after ready
      expect(sendInit).toHaveBeenCalledTimes(1);
    });
  });

  describe('silent-blank guard: readiness timeout arms on start(), not on load', () => {
    it('fires onReadyTimeout when the block never acks', () => {
      const { controller, onReadyTimeout } = makeController({ readyTimeoutMs: 10_000 });
      controller.start();
      expect(onReadyTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(9_999);
      expect(onReadyTimeout).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onReadyTimeout).toHaveBeenCalledTimes(1);
    });

    it('stops re-posting init once the readiness timeout fires', () => {
      const { controller, sendInit } = makeController({ readyTimeoutMs: 10_000 });
      controller.start();
      vi.advanceTimersByTime(10_000); // timeout fires here
      const callsAtTimeout = sendInit.mock.calls.length;
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS * 5);
      expect(sendInit).toHaveBeenCalledTimes(callsAtTimeout);
    });

    it('fires the readiness timeout exactly once', () => {
      const { controller, onReadyTimeout } = makeController({ readyTimeoutMs: 5_000 });
      controller.start();
      vi.advanceTimersByTime(60_000);
      expect(onReadyTimeout).toHaveBeenCalledTimes(1);
    });
  });

  describe('idempotency / lifecycle', () => {
    it('start() is idempotent — a second call does not double the timers', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1);
      advanceThroughReposts(1);
      // one chain, not two — so exactly one extra send at the first gap
      expect(sendInit).toHaveBeenCalledTimes(2);
    });

    it('dispose() stops the interval and the readiness timeout (unmount)', () => {
      const { controller, sendInit, onReadyTimeout } = makeController({
        readyTimeoutMs: 10_000,
      });
      controller.start();
      controller.dispose();
      vi.advanceTimersByTime(60_000);
      expect(sendInit).toHaveBeenCalledTimes(1);
      expect(onReadyTimeout).not.toHaveBeenCalled();
    });

    it('start() after stop() is a no-op (cannot resurrect a disposed controller)', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      controller.dispose();
      controller.start();
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS * 5);
      expect(sendInit).toHaveBeenCalledTimes(1);
    });

    it('notifyReady() before start() prevents any send (defensive)', () => {
      const { controller, sendInit } = makeController();
      controller.notifyReady();
      controller.start();
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS * 5);
      expect(sendInit).not.toHaveBeenCalled();
    });

    it('hasStarted() reflects whether init has begun', () => {
      const { controller } = makeController();
      expect(controller.hasStarted()).toBe(false);
      controller.start();
      expect(controller.hasStarted()).toBe(true);
    });
  });

  /**
   * THE INVERTED HANDSHAKE — and its COMPATIBILITY MATRIX.
   *
   * The block now announces that its listener is attached (`BLOCK_HELLO`) and
   * the host pushes BLOCK_INIT in response. These tests pin the property that
   * makes that safe to ship against already-deployed third-party blocks: the
   * announce is an ACCELERATOR layered on the existing schedule, never a gate.
   * The two cells that matter here are the ones the SDK's own tests structurally
   * cannot cover, because they are claims about the HOST:
   *
   *   - OLD SDK + NEW HOST — a deployed block that never sends BLOCK_HELLO.
   *   - A BLOCK THAT NEVER ANNOUNCES AND NEVER ACKS — must not hang the host.
   */
  describe('BLOCK_HELLO: the inverted handshake is an accelerator, not a gate', () => {
    it('OLD SDK + NEW HOST: a block that never announces is served by the retry loop alone', () => {
      // The whole old-SDK compatibility claim in one assertion: with no
      // BLOCK_HELLO ever delivered, the immediate post + every scheduled re-post
      // still happen. This is the 19-of-23 case as of the 2026-08-31 fleet
      // measurement, so it is the DEFAULT path, not a legacy corner.
      const { controller, sendInit, onReadyTimeout } = makeController({ readyTimeoutMs: 10_000 });
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1); // immediate post

      const elapsed = advanceThroughReposts(5);
      expect(sendInit).toHaveBeenCalledTimes(6); // 1 + 5 retries
      expect(elapsed).toBeLessThan(10_000);
      expect(onReadyTimeout).not.toHaveBeenCalled();
    });

    it('NEVER ANNOUNCES AND NEVER ACKS: the readiness timeout still fires — no hang', () => {
      const { controller, sendInit, onReadyTimeout } = makeController({ readyTimeoutMs: 10_000 });
      controller.start();
      vi.advanceTimersByTime(60_000);
      expect(onReadyTimeout).toHaveBeenCalledTimes(1);
      // …and the retry loop stopped with it, rather than re-posting forever.
      const atTimeout = sendInit.mock.calls.length;
      vi.advanceTimersByTime(60_000);
      expect(sendInit).toHaveBeenCalledTimes(atTimeout);
    });

    it('NEW SDK + NEW HOST: an announce posts BLOCK_INIT immediately, not at the next tick', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1);

      // Half of the FIRST gap in — the retry loop would not have fired yet.
      // 🔴 Keyed to `initRetryDelayMs(0)`, not the steady interval: with the
      // backoff schedule the first gap is 50ms, so advancing half of 400 would
      // already have produced three re-posts and the assertion below would be
      // measuring the loop rather than the announce.
      vi.advanceTimersByTime(Math.floor(initRetryDelayMs(0) / 2));
      expect(sendInit).toHaveBeenCalledTimes(1);

      controller.notifyHello();
      expect(sendInit).toHaveBeenCalledTimes(2);
    });

    it('the announce does NOT cancel the retry loop or the readiness timeout', () => {
      // 🔴 An announce means "I am listening", NOT "I got the payload". Only
      // BLOCK_READY may stop the loop; treating hello as an ack would
      // reintroduce the blank-iframe bug this controller exists to fix.
      const { controller, sendInit, onReadyTimeout } = makeController({ readyTimeoutMs: 10_000 });
      controller.start();
      controller.notifyHello();
      const afterHello = sendInit.mock.calls.length;

      // 🔴 The announce must not RESCHEDULE the chain either — the next three
      // re-posts still land on the gaps they were already on, so advancing by
      // exactly those gaps yields exactly three more posts.
      advanceThroughReposts(3);
      expect(sendInit.mock.calls.length).toBe(afterHello + 3);

      vi.advanceTimersByTime(10_000);
      expect(onReadyTimeout).toHaveBeenCalledTimes(1);
    });

    it('is honored at most ONCE — a chatty block cannot amplify host work', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      for (let i = 0; i < 50; i += 1) controller.notifyHello();
      expect(sendInit).toHaveBeenCalledTimes(2); // the immediate post + one hello
    });

    it('an announce BEFORE start() sends nothing, and start() still posts immediately', () => {
      // The host registers its BLOCK_HELLO listener before the controller
      // exists (token/checkpoint may still be resolving). A hello landing then
      // must not post — there is no payload yet — and must not suppress the
      // immediate post start() owes.
      const { controller, sendInit } = makeController();
      controller.notifyHello();
      expect(sendInit).not.toHaveBeenCalled();
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1);
    });

    it('an announce after notifyReady()/dispose() sends nothing', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      controller.notifyReady();
      controller.notifyHello();
      expect(sendInit).toHaveBeenCalledTimes(1);

      const second = makeController();
      second.controller.start();
      second.controller.dispose();
      second.controller.notifyHello();
      expect(second.sendInit).toHaveBeenCalledTimes(1);
    });
  });
});
