import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IframeInitController, INIT_RETRY_INTERVAL_MS } from '../iframeInitController';

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
  }) {
    const sendInit = overrides?.sendInit ?? vi.fn();
    const onReadyTimeout = overrides?.onReadyTimeout ?? vi.fn();
    const controller = new IframeInitController({
      sendInit,
      onReadyTimeout,
      readyTimeoutMs: overrides?.readyTimeoutMs ?? 10_000,
      retryIntervalMs: overrides?.retryIntervalMs,
    });
    return { controller, sendInit, onReadyTimeout };
  }

  describe('the race: init does not depend on the iframe load event', () => {
    it('posts BLOCK_INIT immediately on start(), with no load signal', () => {
      const { controller, sendInit } = makeController();
      // No `onLoad` is ever simulated — the controller has no concept of it.
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1);
    });

    it('keeps re-posting BLOCK_INIT on the retry interval until acked', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1); // immediate

      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS);
      expect(sendInit).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS);
      expect(sendInit).toHaveBeenCalledTimes(3);

      // Several more ticks — still re-sending because no BLOCK_READY arrived.
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS * 3);
      expect(sendInit).toHaveBeenCalledTimes(6);
    });

    it('uses the configurable retry interval', () => {
      const { controller, sendInit } = makeController({ retryIntervalMs: 250 });
      controller.start();
      expect(sendInit).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(250);
      expect(sendInit).toHaveBeenCalledTimes(2);
    });
  });

  describe('retry stops once the block acks (BLOCK_READY → notifyReady)', () => {
    it('stops re-posting after notifyReady()', () => {
      const { controller, sendInit } = makeController();
      controller.start();
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS); // -> 2 sends
      expect(sendInit).toHaveBeenCalledTimes(2);

      controller.notifyReady();

      // No further sends, ever.
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS * 10);
      expect(sendInit).toHaveBeenCalledTimes(2);
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
      vi.advanceTimersByTime(INIT_RETRY_INTERVAL_MS);
      // one interval, not two — so exactly one extra send
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
});
