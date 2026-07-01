import { describe, expect, it, vi } from 'vitest';
import { createLagTracker, type LagStore } from './lag';

// A fake flag store — an in-memory map plus call spies, so we can assert exactly what the tracker
// reads/writes without redis.
function fakeStore() {
  const map = new Map<string, string>();
  const setCalls: Array<{ key: string; value: string; opts: { EX: number } }> = [];
  const store: LagStore = {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value, opts) => {
      map.set(key, value);
      setCalls.push({ key, value, opts });
    },
  };
  return { store, map, setCalls };
}

describe('createLagTracker', () => {
  it('routes stale when the key is flagged, fresh otherwise', async () => {
    const { store, map } = fakeStore();
    const tracker = createLagTracker({ store, delaySeconds: 5 });

    expect(await tracker.isStale('k')).toBe(false);
    map.set('k', 'true');
    expect(await tracker.isStale('k')).toBe(true);
  });

  it('markFresh writes the flag with EX = delaySeconds', async () => {
    const { store, setCalls } = fakeStore();
    const tracker = createLagTracker({ store, delaySeconds: 30 });

    await tracker.markFresh('user:1');
    expect(setCalls).toEqual([{ key: 'user:1', value: 'true', opts: { EX: 30 } }]);
  });

  it('is disabled when delaySeconds <= 0 — never touches the store', async () => {
    const { store, setCalls } = fakeStore();
    const getSpy = vi.spyOn(store, 'get');
    const tracker = createLagTracker({ store, delaySeconds: 0 });

    expect(await tracker.isStale('k')).toBe(false);
    await tracker.markFresh('k');
    expect(getSpy).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });

  it('degrades to always-fresh when the store is null', async () => {
    const tracker = createLagTracker({ store: null, delaySeconds: 5 });
    expect(await tracker.isStale('k')).toBe(false);
    await expect(tracker.markFresh('k')).resolves.toBeUndefined(); // no throw
  });

  it('resolves a thunk store lazily and memoizes it (resolved once)', async () => {
    const { store } = fakeStore();
    const thunk = vi.fn(() => store);
    const tracker = createLagTracker({ store: thunk, delaySeconds: 5 });

    expect(thunk).not.toHaveBeenCalled(); // not resolved at construction
    await tracker.isStale('k');
    await tracker.markFresh('k');
    await tracker.isStale('k');
    expect(thunk).toHaveBeenCalledTimes(1); // resolved once, then memoized
  });
});
