import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type { CandidateFilter, CandidateSource } from '~/server/services/semantic-search-client';
import { withCandidateCache } from '~/server/services/semantic-candidate-cache';

const filter = (nsfwLevels = [1, 2]): CandidateFilter => ({
  gate: { kind: 'level', nsfwLevels },
});

/** A ranked list of `total` ids, recording every call it answers. */
function rankedSource(total = 1000, correctedQuery?: string) {
  const calls: { offset: number; limit: number }[] = [];
  const source: CandidateSource = async ({ offset, limit }) => {
    calls.push({ offset, limit });
    const ids = Array.from(
      { length: Math.max(0, Math.min(limit, total - offset)) },
      (_, i) => offset + i + 1
    );
    return { ids, correctedQuery };
  };
  return { source, calls };
}

beforeEach(() => {
  installFakeCacheRedis();
});

describe('withCandidateCache', () => {
  it('answers a repeated search from the cache', async () => {
    const { source, calls } = rankedSource();
    const search = withCandidateCache('images', source, 'user');
    const first = await search({ query: { text: 'fox' }, filter: filter(), offset: 0, limit: 50 });
    const again = await search({ query: { text: 'fox' }, filter: filter(), offset: 0, limit: 50 });
    expect(again.ids).toEqual(first.ids);
    expect(first.ids).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(calls).toHaveLength(1);
  });

  it('serves any offset from the aligned blocks, so viewers at different cursors share them', async () => {
    const { source, calls } = rankedSource();
    const search = withCandidateCache('images', source, 'user');
    const run = (offset: number, limit: number) =>
      search({ query: { text: 'fox' }, filter: filter(), offset, limit });

    expect((await run(58, 100)).ids).toEqual(Array.from({ length: 100 }, (_, i) => 59 + i));
    expect((await run(62, 100)).ids).toEqual(Array.from({ length: 100 }, (_, i) => 63 + i));
    expect((await run(0, 100)).ids[0]).toBe(1);
    expect(calls).toEqual([
      { offset: 0, limit: 100 },
      { offset: 100, limit: 100 },
    ]);
  });

  it('stops at the end of the ranking without asking for an empty block', async () => {
    const { source, calls } = rankedSource(130);
    const search = withCandidateCache('images', source, 'user');
    const { ids } = await search({
      query: { text: 'fox' },
      filter: filter(),
      offset: 90,
      limit: 100,
    });
    expect(ids).toEqual(Array.from({ length: 40 }, (_, i) => 91 + i));
    expect(calls).toHaveLength(2);
  });

  it('keeps a block per browsing level, query and viewer class', async () => {
    const { source, calls } = rankedSource();
    const args = { query: { text: 'fox' }, filter: filter(), offset: 0, limit: 50 };
    await withCandidateCache('images', source, 'user')(args);
    await withCandidateCache('images', source, 'user')({ ...args, filter: filter([1]) });
    await withCandidateCache('images', source, 'user')({ ...args, query: { text: 'cat' } });
    await withCandidateCache('images', source, 'mod')(args);
    expect(calls).toHaveLength(4);
  });

  it('fetches a block once per request, across its hydration rounds', async () => {
    const { source, calls } = rankedSource();
    const search = withCandidateCache('images', source, 'user');
    const reads = redisMock.redis.packed.get.mock.calls.length;
    await search({ query: { text: 'fox' }, filter: filter(), offset: 0, limit: 60 });
    await search({ query: { text: 'fox' }, filter: filter(), offset: 40, limit: 30 });
    expect(calls).toHaveLength(1);
    expect(redisMock.redis.packed.get.mock.calls.length - reads).toBe(1);
  });

  it('refetches a range whose cached blocks disagree on the spelling correction', async () => {
    const service: { correctedQuery?: string } = {};
    const calls: number[] = [];
    const source: CandidateSource = async ({ offset }) => {
      calls.push(offset);
      const ids = Array.from({ length: 100 }, (_, i) => offset + i + 1);
      return { ids, correctedQuery: service.correctedQuery };
    };
    const args = { query: { text: 'red foks' }, filter: filter(), limit: 50 };
    await withCandidateCache('images', source, 'user')({ ...args, offset: 0 });
    service.correctedQuery = 'red fox';
    await withCandidateCache('images', source, 'user')({ ...args, offset: 100 });

    const spanning = await withCandidateCache('images', source, 'user')({ ...args, offset: 80 });
    expect(spanning.correctedQuery).toBe('red fox');
    expect(calls).toEqual([0, 100, 0, 100]);
  });

  it('makes one call for identical searches in flight together', async () => {
    const { source, calls } = rankedSource();
    const search = withCandidateCache('images', source, 'user');
    const args = { query: { text: 'fox' }, filter: filter(), offset: 0, limit: 50 };
    await Promise.all([search(args), search(args), search(args)]);
    expect(calls).toHaveLength(1);
  });

  it('still answers when the cache read stalls', async () => {
    vi.useFakeTimers();
    try {
      redisMock.redis.packed.get.mockImplementation(() => new Promise(() => undefined));
      const { source } = rankedSource();
      let answered: number[] | undefined;
      void withCandidateCache(
        'images',
        source,
        'user'
      )({
        query: { text: 'fox' },
        filter: filter(),
        offset: 0,
        limit: 50,
      }).then((result) => (answered = result.ids));
      // Past the read deadline, the search has answered from the service.
      await vi.advanceTimersByTimeAsync(300);
      expect(answered).toHaveLength(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('turns a search away with 429 once the pod has its cap of searches in flight', async () => {
    setEnv({ SEMANTIC_SEARCH_CONCURRENCY: 1 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const source: CandidateSource = async ({ query }) => {
      if ('text' in query && query.text === 'slow') await held;
      return { ids: [1] };
    };
    const search = (text: string) =>
      withCandidateCache(
        'images',
        source,
        'user'
      )({
        query: { text },
        filter: filter(),
        offset: 0,
        limit: 50,
      });
    const slow = search('slow');
    const outcome = await Promise.race([
      search('other').then(
        () => 'answered',
        (error: { code?: string }) => error.code
      ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);
    expect(outcome).toBe('TOO_MANY_REQUESTS');
    release();
    expect((await slow).ids).toEqual([1]);
  });
});
