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

  it('runs work a released callback starts synchronously in the same release', async () => {
    // A released batcher flush sends its query from inside the release; that query must leave with
    // the window that released it, not wait for another one.
    deferToBatchWindow(() => deferToBatchWindow(at('nested')));
    await vi.advanceTimersByTimeAsync(16);
    expect(log).toEqual(['nested@16']);
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

  it('ON where batching applies: each batcher keeps its own window, then waits for a shared close', async () => {
    registerBatchingApplies(() => true);
    setTrpcUnifiedBatchWindowEnabled(true);
    scheduleBatcherFlush(at('sale'), 50);
    scheduleBatcherFlush(at('engaged'), 80);
    await vi.advanceTimersByTimeAsync(49);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    // Nothing else was pending, so each flush opened its own shared window: 50 + 16, 80 + 16.
    expect(log).toEqual(['sale@66', 'engaged@96']);
  });

  it('ON: a batcher flush joins a shared window that is already open', async () => {
    registerBatchingApplies(() => true);
    setTrpcUnifiedBatchWindowEnabled(true);
    scheduleBatcherFlush(at('engaged'), 80);
    await vi.advanceTimersByTimeAsync(75);
    deferToBatchWindow(at('query')); // opens a window closing at 91
    await vi.advanceTimersByTimeAsync(50);
    expect(log).toEqual(['query@91', 'engaged@91']);
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
