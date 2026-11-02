import { describe, expect, it, vi } from 'vitest';
import {
  acknowledgePassedSummary,
  markPassedSummary,
  memorySummaryStore,
  pendingPassedSummary,
  redisSummaryStore,
  type SummaryStore,
} from './pending-summary';

describe('the passed-summary marker', () => {
  it('stays pending until acknowledged, then never again', async () => {
    const store = memorySummaryStore();
    expect(await pendingPassedSummary(store, 1)).toBeNull();

    await markPassedSummary(store, 1, 42);
    expect(await pendingPassedSummary(store, 1)).toBe(42);
    expect(await pendingPassedSummary(store, 1)).toBe(42);
    expect(await pendingPassedSummary(store, 2)).toBeNull();

    expect(await acknowledgePassedSummary(store, 1)).toBe(true);
    expect(await pendingPassedSummary(store, 1)).toBeNull();
  });

  it('reads a stored 0 or a value that is not ours as nothing pending', async () => {
    const values = new Map<string, string>([
      ['knights:trial-summary:1', '0'],
      ['knights:trial-summary:2', 'junk'],
    ]);
    const store = redisSummaryStore(() => ({
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => values.set(key, value),
    }));
    expect(await pendingPassedSummary(store, 1)).toBeNull();
    expect(await pendingPassedSummary(store, 2)).toBeNull();
    expect(await pendingPassedSummary(store, 3)).toBeNull();
  });

  it('never blocks the player when the store is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const down: SummaryStore = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
    };
    await expect(markPassedSummary(down, 1, 5)).resolves.toBeUndefined();
    expect(await pendingPassedSummary(down, 1)).toBeNull();
    expect(await acknowledgePassedSummary(down, 1)).toBe(false);
  });
});
