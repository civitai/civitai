import { describe, it, expect, vi } from 'vitest';
import { createLruCache } from '../lru-cache';

const TTL = 20;
const expire = () => new Promise((r) => setTimeout(r, TTL * 2));

// One fetchFn that succeeds n times then rejects, so a test can drive the cache to the failure it cares
// about without reaching into the cache's internals.
function fetcher(values: (string | Error)[]) {
  let i = 0;
  return vi.fn(async () => {
    const next = values[Math.min(i, values.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next;
  });
}

describe('createLruCache allowStale', () => {
  it('serves the expired value when the fetch rejects', async () => {
    const fetchFn = fetcher(['fresh', new Error('backend down')]);
    const cache = createLruCache<string, string>({
      name: 't',
      ttl: TTL,
      allowStale: true,
      keyFn: (k) => k,
      fetchFn,
    });

    expect(await cache.fetch('k')).toBe('fresh');
    await expire();

    expect(await cache.fetch('k')).toBe('fresh');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('keeps serving stale across repeated failures', async () => {
    const fetchFn = fetcher(['fresh', new Error('still down')]);
    const cache = createLruCache<string, string>({
      name: 't',
      ttl: TTL,
      allowStale: true,
      keyFn: (k) => k,
      fetchFn,
    });

    await cache.fetch('k');
    await expire();
    await cache.fetch('k');
    await expire();

    // The first stale serve must not consume the entry, or the second outage returns nothing.
    expect(await cache.fetch('k')).toBe('fresh');
  });

  it('refreshes rather than serving stale while the fetch works', async () => {
    const fetchFn = fetcher(['first', 'second']);
    const cache = createLruCache<string, string>({
      name: 't',
      ttl: TTL,
      allowStale: true,
      keyFn: (k) => k,
      fetchFn,
    });

    expect(await cache.fetch('k')).toBe('first');
    await expire();

    // Guards against enabling allowStale on the cache itself, which would serve 'first' forever.
    expect(await cache.fetch('k')).toBe('second');
  });

  it('throws when nothing was ever cached', async () => {
    const cache = createLruCache<string, string>({
      name: 't',
      ttl: TTL,
      allowStale: true,
      keyFn: (k) => k,
      fetchFn: fetcher([new Error('cold start')]),
    });

    await expect(cache.fetch('k')).rejects.toThrow('cold start');
  });

  it('propagates the rejection when allowStale is off', async () => {
    const cache = createLruCache<string, string>({
      name: 't',
      ttl: TTL,
      keyFn: (k) => k,
      fetchFn: fetcher(['fresh', new Error('backend down')]),
    });

    expect(await cache.fetch('k')).toBe('fresh');
    await expire();
    await expect(cache.fetch('k')).rejects.toThrow('backend down');
  });
});
