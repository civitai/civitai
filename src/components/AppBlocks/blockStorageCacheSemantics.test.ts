import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { BLOCK_STORAGE_READ_OPTS, BLOCK_STORAGE_READ_STALE_TIME_MS } from './blockStorageCache';

/**
 * The LIBRARY CONTRACT the block storage cache policy rests on.
 *
 * Why this file exists: every other test of this policy mocks `~/utils/trpc`
 * wholesale, so `fetch` and `invalidate` are `vi.fn()`s and React Query is never
 * involved at all. Those tests pin the CALL SHAPE — that the host passes a
 * staleTime and calls invalidate in the right order — but nothing in the repo
 * checked that a per-call `staleTime` actually bounds `fetchQuery`, or that a
 * namespace-level `invalidate` actually reaches these keys. An adversarial audit
 * pointed out the whole mechanism could break under a `@tanstack/query-core`
 * upgrade with every existing test still green.
 *
 * So these exercise a REAL `QueryClient`, with the real tRPC key shape
 * (`[[...path], { input, type }]`), and no mock of the query layer.
 *
 * If one of these fails after a dependency bump, the fix is not to relax it —
 * it means the cache policy in `blockStorageCache.ts` no longer does what its
 * doc-comment claims, and the hosts need rewiring.
 */

// The key shape tRPC's react-query adapter produces.
const sharedListKey = [['apps', 'shared', 'list'], { input: { blockToken: 't' }, type: 'query' }];
const sharedGetCountKey = [['apps', 'shared', 'getCount'], { input: { key: 'k' }, type: 'query' }];
const storageGetKey = [['apps', 'storage', 'get'], { input: { key: 'k' }, type: 'query' }];

function makeClient() {
  // Mirrors the app's global default — the whole reason this policy is needed.
  return new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
}

describe('block storage cache — real query-core semantics', () => {
  it('a per-call staleTime overrides a global staleTime: Infinity', async () => {
    const client = makeClient();
    const queryFn = vi.fn().mockResolvedValue('v1');

    await client.fetchQuery({ queryKey: sharedListKey, queryFn, ...BLOCK_STORAGE_READ_OPTS });
    expect(queryFn).toHaveBeenCalledTimes(1);

    // Inside the window: served from cache.
    await client.fetchQuery({ queryKey: sharedListKey, queryFn, ...BLOCK_STORAGE_READ_OPTS });
    expect(queryFn).toHaveBeenCalledTimes(1);

    // Past the window: refetched. This is what makes ANOTHER user's write
    // visible without a page reload — the half invalidation cannot fix.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + BLOCK_STORAGE_READ_STALE_TIME_MS + 50);
      await client.fetchQuery({ queryKey: sharedListKey, queryFn, ...BLOCK_STORAGE_READ_OPTS });
    } finally {
      vi.useRealTimers();
    }
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('WITHOUT the per-call staleTime the same read never refetches (the bug)', async () => {
    // Negative control: proves the assertion above is about BLOCK_STORAGE_READ_OPTS
    // and not about something query-core does anyway.
    const client = makeClient();
    const queryFn = vi.fn().mockResolvedValue('v1');

    await client.fetchQuery({ queryKey: sharedListKey, queryFn });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 60 * 60 * 1000);
      await client.fetchQuery({ queryKey: sharedListKey, queryFn });
    } finally {
      vi.useRealTimers();
    }
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it('a namespace invalidate re-arms every read under apps.shared', async () => {
    const client = makeClient();
    const listFn = vi.fn().mockResolvedValue('list-v1');
    const countFn = vi.fn().mockResolvedValue('count-v1');

    await client.fetchQuery({
      queryKey: sharedListKey,
      queryFn: listFn,
      ...BLOCK_STORAGE_READ_OPTS,
    });
    await client.fetchQuery({
      queryKey: sharedGetCountKey,
      queryFn: countFn,
      ...BLOCK_STORAGE_READ_OPTS,
    });

    // What invalidateSharedStorageReads does.
    await client.invalidateQueries({ queryKey: [['apps', 'shared']] });

    await client.fetchQuery({
      queryKey: sharedListKey,
      queryFn: listFn,
      ...BLOCK_STORAGE_READ_OPTS,
    });
    await client.fetchQuery({
      queryKey: sharedGetCountKey,
      queryFn: countFn,
      ...BLOCK_STORAGE_READ_OPTS,
    });

    // Both re-fetched immediately, without waiting out the staleTime — this is
    // what makes the block's OWN write visible at once.
    expect(listFn).toHaveBeenCalledTimes(2);
    expect(countFn).toHaveBeenCalledTimes(2);
  });

  it('the shared namespace invalidate does NOT reach apps.storage (and vice versa)', async () => {
    // Isolation control: the two helpers must not be interchangeable, or the
    // private/shared split in blockStorageCache.ts is decorative.
    const client = makeClient();
    const storageFn = vi.fn().mockResolvedValue('s-v1');
    const sharedFn = vi.fn().mockResolvedValue('h-v1');

    await client.fetchQuery({
      queryKey: storageGetKey,
      queryFn: storageFn,
      ...BLOCK_STORAGE_READ_OPTS,
    });
    await client.fetchQuery({
      queryKey: sharedListKey,
      queryFn: sharedFn,
      ...BLOCK_STORAGE_READ_OPTS,
    });

    await client.invalidateQueries({ queryKey: [['apps', 'shared']] });

    await client.fetchQuery({
      queryKey: storageGetKey,
      queryFn: storageFn,
      ...BLOCK_STORAGE_READ_OPTS,
    });
    expect(storageFn).toHaveBeenCalledTimes(1); // untouched

    await client.invalidateQueries({ queryKey: [['apps', 'storage']] });
    await client.fetchQuery({
      queryKey: storageGetKey,
      queryFn: storageFn,
      ...BLOCK_STORAGE_READ_OPTS,
    });
    expect(storageFn).toHaveBeenCalledTimes(2); // now re-armed
  });

  it('an in-flight read that resolves after an invalidate CLEARS it — bounded by staleTime', async () => {
    // The race the policy exists to bound. successState() sets
    // isInvalidated:false, so a read started before the write and resolving
    // after it re-marks pre-write data as fresh. Under staleTime:Infinity that
    // is permanent; the bound is what caps it at one staleTime.
    const client = makeClient();
    let release!: (v: string) => void;
    const first = new Promise<string>((r) => (release = r));
    const queryFn = vi.fn().mockReturnValueOnce(first).mockResolvedValue('fresh');

    const inFlight = client.fetchQuery({
      queryKey: sharedListKey,
      queryFn,
      ...BLOCK_STORAGE_READ_OPTS,
    });
    await client.invalidateQueries({ queryKey: [['apps', 'shared']] });
    release('stale');
    await inFlight;

    // Immediately after: the invalidation was undone, so this is a cache hit.
    await client.fetchQuery({ queryKey: sharedListKey, queryFn, ...BLOCK_STORAGE_READ_OPTS });
    expect(queryFn).toHaveBeenCalledTimes(1);

    // But only until the bound expires — the harm is capped, not permanent.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + BLOCK_STORAGE_READ_STALE_TIME_MS + 50);
      await client.fetchQuery({ queryKey: sharedListKey, queryFn, ...BLOCK_STORAGE_READ_OPTS });
    } finally {
      vi.useRealTimers();
    }
    expect(queryFn).toHaveBeenCalledTimes(2);
  });
});
