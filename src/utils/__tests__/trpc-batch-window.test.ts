import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetTrpcBatchWindow,
  deferToBatchWindow,
  registerBatchingApplies,
  scheduleBatcherFlush,
  setTrpcUnifiedBatchWindowEnabled,
} from '~/utils/trpc-batch-window';

/**
 * The window's timing contract, with fake timers so every position is exact. `log` records the fake
 * clock at which each callback ran.
 */
const log: string[] = [];
const at = (name: string) => () => log.push(`${name}@${Date.now()}`);

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  log.length = 0;
  __resetTrpcBatchWindow();
});

afterEach(() => {
  __resetTrpcBatchWindow();
  registerBatchingApplies(() => false);
  vi.useRealTimers();
});

describe('deferToBatchWindow', () => {
  it('releases everything queued within 16 ms of the first call together, at 16 ms', async () => {
    deferToBatchWindow(at('a'));
    await vi.advanceTimersByTimeAsync(10);
    deferToBatchWindow(at('b'));
    await vi.advanceTimersByTimeAsync(5);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(['a@16', 'b@16']);
  });

  it('does not slide: a call after the release opens the next window', async () => {
    deferToBatchWindow(at('a'));
    await vi.advanceTimersByTimeAsync(20);
    deferToBatchWindow(at('b'));
    await vi.advanceTimersByTimeAsync(16);
    expect(log).toEqual(['a@16', 'b@36']);
  });

  it('runs work a released callback starts from a promise continuation in the same release', async () => {
    // The sale-badge batcher sends from `Promise.resolve().then(...)`; that query must still leave
    // with the window that released it, not wait for another one.
    deferToBatchWindow(() => {
      void Promise.resolve().then(() => deferToBatchWindow(at('continuation')));
    });
    await vi.advanceTimersByTimeAsync(16);
    expect(log).toEqual(['continuation@16']);
  });
});

describe('scheduleBatcherFlush', () => {
  it('OFF: keeps the batcher on its own timer', async () => {
    registerBatchingApplies(() => true);
    setTrpcUnifiedBatchWindowEnabled(false);
    scheduleBatcherFlush(at('sale'), 50);
    scheduleBatcherFlush(at('engaged'), 80);
    await vi.advanceTimersByTimeAsync(100);
    expect(log).toEqual(['sale@50', 'engaged@80']);
  });

  it('ON where batching applies: both batchers flush on the shared window', async () => {
    registerBatchingApplies(() => true);
    setTrpcUnifiedBatchWindowEnabled(true);
    scheduleBatcherFlush(at('sale'), 50);
    scheduleBatcherFlush(at('engaged'), 80);
    await vi.advanceTimersByTimeAsync(100);
    expect(log).toEqual(['sale@16', 'engaged@16']);
  });

  it('ON where batching does not apply: own timers, since nothing would be merged', async () => {
    registerBatchingApplies(() => false);
    setTrpcUnifiedBatchWindowEnabled(true);
    scheduleBatcherFlush(at('sale'), 50);
    scheduleBatcherFlush(at('engaged'), 80);
    await vi.advanceTimersByTimeAsync(100);
    expect(log).toEqual(['sale@50', 'engaged@80']);
  });
});
