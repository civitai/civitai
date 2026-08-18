import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDismissalStore,
  localStorageDismissalStorage,
  type DismissalBuckets,
  type DismissalStorage,
} from '~/store/dismissal-store';

type Bucket = 'site' | 'generator';

/** In-memory adapter — the seam that makes the store testable without storage. */
function memoryStorage(initial?: Partial<DismissalBuckets<Bucket, number>>) {
  let value: DismissalBuckets<Bucket, number> = {
    site: initial?.site ?? [],
    generator: initial?.generator ?? [],
  };
  const write = vi.fn((next: DismissalBuckets<Bucket, number>) => {
    value = next;
  });
  const storage: DismissalStorage<Bucket, number> = { read: () => value, write };
  return { storage, write, current: () => value };
}

const makeStore = (initial?: Partial<DismissalBuckets<Bucket, number>>) => {
  const backing = memoryStorage(initial);
  const store = createDismissalStore<number, Bucket>({
    storage: backing.storage,
    defaultBucket: 'site',
  });
  return { ...backing, store };
};

describe('createDismissalStore', () => {
  it('seeds state from storage', () => {
    const { store } = makeStore({ site: [1, 2] });

    expect(store.getDismissed('site')).toEqual([1, 2]);
  });

  it('dismisses into the default bucket when none is named', () => {
    const { store, current } = makeStore();

    store.dismiss(5);

    expect(store.getDismissed()).toEqual([5]);
    expect(current().site).toEqual([5]);
  });

  it('writes state and storage together', () => {
    const { store, write, current } = makeStore();

    store.dismiss([1, 2], 'generator');

    expect(store.getDismissed('generator')).toEqual([1, 2]);
    expect(current().generator).toEqual([1, 2]);
    expect(write).toHaveBeenCalledTimes(1);
  });

  // The property the factory exists to guarantee: no gratuitous persist.
  it('does not write when the id was already dismissed', () => {
    const { store, write } = makeStore({ site: [1] });

    store.dismiss(1);

    expect(write).not.toHaveBeenCalled();
  });

  it('does not write when nothing was stale', () => {
    const { store, write } = makeStore({ site: [1, 2] });

    store.prune([1, 2, 3]);

    expect(write).not.toHaveBeenCalled();
  });

  it('prunes stale ids and persists once', () => {
    const { store, write, current } = makeStore({ site: [1, 2, 3] });

    store.prune([2]);

    expect(store.getDismissed()).toEqual([2]);
    expect(current().site).toEqual([2]);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps buckets independent', () => {
    const { store } = makeStore({ site: [1], generator: [2] });

    store.prune([], 'site');

    expect(store.getDismissed('site')).toEqual([]);
    expect(store.getDismissed('generator')).toEqual([2]);
  });

  it('exposes the raw store with the full bucket map', () => {
    const { store } = makeStore({ site: [1] });

    expect(store.useStore.getState().dismissed).toEqual({ site: [1], generator: [] });
  });
});

describe('localStorageDismissalStorage', () => {
  const isNumber = (value: unknown): value is number => typeof value === 'number';

  function stubLocalStorage(seed: Record<string, string> = {}) {
    const data = new Map(Object.entries(seed));
    const localStorage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    vi.stubGlobal('window', { localStorage });
    return data;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const adapter = (onRead?: () => void) =>
    localStorageDismissalStorage<number, Bucket>({
      key: 'test-dismissed',
      buckets: ['site', 'generator'],
      isId: isNumber,
      onRead,
    });

  it('round-trips through storage', () => {
    stubLocalStorage();
    const storage = adapter();

    storage.write({ site: [1], generator: [2] });

    expect(storage.read()).toEqual({ site: [1], generator: [2] });
  });

  it('reads every bucket as empty when nothing is stored', () => {
    stubLocalStorage();

    expect(adapter().read()).toEqual({ site: [], generator: [] });
  });

  it('returns the empty set for an unparseable payload', () => {
    stubLocalStorage({ 'test-dismissed': 'not json' });

    expect(adapter().read()).toEqual({ site: [], generator: [] });
  });

  it('returns the empty set for a non-object payload', () => {
    stubLocalStorage({ 'test-dismissed': '42' });

    expect(adapter().read()).toEqual({ site: [], generator: [] });
  });

  it('drops values of the wrong type and unknown buckets', () => {
    stubLocalStorage({
      'test-dismissed': JSON.stringify({ site: [1, 'two', null, 3], nope: [9] }),
    });

    expect(adapter().read()).toEqual({ site: [1, 3], generator: [] });
  });

  it('tolerates a bucket holding a non-array', () => {
    stubLocalStorage({ 'test-dismissed': JSON.stringify({ site: 'nope' }) });

    expect(adapter().read()).toEqual({ site: [], generator: [] });
  });

  it('runs onRead once per read, for collecting an older scheme’s keys', () => {
    stubLocalStorage();
    const onRead = vi.fn();

    adapter(onRead).read();

    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it('reads empty on the server, where there is no window', () => {
    vi.stubGlobal('window', undefined);

    expect(adapter().read()).toEqual({ site: [], generator: [] });
  });

  it('does not throw when storage refuses a write', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => undefined,
      },
    });

    expect(() => adapter().write({ site: [1], generator: [] })).not.toThrow();
  });
});
