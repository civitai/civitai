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

  it('is disabled (not enabled) when delaySeconds is NaN — never touches the store or writes EX:NaN', async () => {
    const { store, setCalls } = fakeStore();
    const getSpy = vi.spyOn(store, 'get');
    // e.g. a non-numeric REPLICATION_LAG_DELAY → Number('bad') === NaN, and NaN <= 0 is false.
    const tracker = createLagTracker({ store, delaySeconds: Number('bad') });

    expect(await tracker.isStale('k')).toBe(false);
    await tracker.markFresh('k');
    expect(getSpy).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });

  it('does NOT cache a null store — a thunk that returns null first picks up the store later', async () => {
    const { store, map } = fakeStore();
    let ready = false;
    const thunk = vi.fn(() => (ready ? store : null));
    const tracker = createLagTracker({ store: thunk, delaySeconds: 5 });

    // Store not ready yet → degrades to always-fresh, and does not memoize the null.
    expect(await tracker.isStale('k')).toBe(false);

    // Store becomes available; the tracker must resolve it now (null was not cached).
    ready = true;
    map.set('k', 'true');
    expect(await tracker.isStale('k')).toBe(true);
    expect(thunk).toHaveBeenCalledTimes(2);
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

// The flag read sits in front of model/post page reads. A store that is down must not hold them:
// a missing flag already means "read the replica", so an unreadable one means the same, promptly.
describe('createLagTracker — flag store unavailable', () => {
  const HUNG = Symbol('hung');
  const within = <T>(p: Promise<T>, ms: number) =>
    Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

  function storeWith(get: LagStore['get']): LagStore {
    return { get, set: async () => undefined };
  }

  it('a rejecting store reads as fresh (replica) and reports the failure', async () => {
    const onReadFailure = vi.fn();
    const tracker = createLagTracker({
      store: storeWith(() => Promise.reject(new Error('store down'))),
      delaySeconds: 5,
      onReadFailure,
    });

    await expect(within(tracker.isStale('k'), 2000)).resolves.toBe(false);
    expect(onReadFailure).toHaveBeenCalledWith('error', expect.any(Error));
  });

  it('a store that never answers reads as fresh within 450ms by default', async () => {
    const onReadFailure = vi.fn();
    const tracker = createLagTracker({
      store: storeWith(() => new Promise(() => {})),
      delaySeconds: 5,
      onReadFailure,
    });

    const started = Date.now();
    await expect(within(tracker.isStale('k'), 2000)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(450);
    expect(onReadFailure).toHaveBeenCalledWith('timeout', expect.any(Error));
  });

  it('readTimeoutMs bounds the wait at the value given', async () => {
    const tracker = createLagTracker({
      store: storeWith(() => new Promise(() => {})),
      delaySeconds: 5,
      readTimeoutMs: 30,
    });

    const started = Date.now();
    await expect(within(tracker.isStale('k'), 2000)).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('a slow store that answers inside the bound still routes to the primary', async () => {
    const tracker = createLagTracker({
      store: storeWith(() => new Promise((r) => setTimeout(() => r('true'), 20))),
      delaySeconds: 5,
      readTimeoutMs: 500,
    });

    await expect(tracker.isStale('k')).resolves.toBe(true);
  });
});
