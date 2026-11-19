import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { parseGuardStatus, type GuardStatus } from '~/server/services/semantic-guard-status';
import type {
  CandidateFilter,
  CandidateSource,
  GuardRead,
} from '~/server/services/semantic-search-client';

const h = vi.hoisted(() => ({ auditFlag: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFlipt: async (flag: string) => flag === 'semantic-search-audit' && h.auditFlag,
}));

const { withCandidateCache } = await import('~/server/services/semantic-candidate-cache');

const viewer = { isModerator: false };
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
  h.auditFlag = false;
});

describe('withCandidateCache', () => {
  it('answers a repeated search from the cache', async () => {
    const { source, calls } = rankedSource();
    const search = withCandidateCache('images', source, 'user');
    const first = await search({
      query: { text: 'fox' },
      filter: filter(),
      offset: 0,
      limit: 50,
      viewer,
    });
    const again = await search({
      query: { text: 'fox' },
      filter: filter(),
      offset: 0,
      limit: 50,
      viewer,
    });
    expect(again.ids).toEqual(first.ids);
    expect(first.ids).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(calls).toHaveLength(1);
  });

  it('serves any offset from the aligned blocks, so viewers at different cursors share them', async () => {
    const { source, calls } = rankedSource();
    const search = withCandidateCache('images', source, 'user');
    const run = (offset: number, limit: number) =>
      search({ query: { text: 'fox' }, filter: filter(), offset, limit, viewer });

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
      viewer,
    });
    expect(ids).toEqual(Array.from({ length: 40 }, (_, i) => 91 + i));
    expect(calls).toHaveLength(2);
  });

  it('keeps a block per browsing level, query, sort and viewer class', async () => {
    const { source, calls } = rankedSource();
    const args = { query: { text: 'fox' }, filter: filter(), offset: 0, limit: 50, viewer };
    await withCandidateCache('images', source, 'user')(args);
    await withCandidateCache('images', source, 'user')({ ...args, filter: filter([1]) });
    await withCandidateCache('images', source, 'user')({ ...args, query: { text: 'cat' } });
    await withCandidateCache('images', source, 'mod')(args);
    await withCandidateCache('images', source, 'user')({ ...args, sort: 'newest' });
    expect(calls).toHaveLength(5);
  });

  it('fetches a block once per request, across its hydration rounds', async () => {
    const { source, calls } = rankedSource();
    const search = withCandidateCache('images', source, 'user');
    const reads = redisMock.redis.packed.get.mock.calls.length;
    await search({ query: { text: 'fox' }, filter: filter(), offset: 0, limit: 60, viewer });
    await search({ query: { text: 'fox' }, filter: filter(), offset: 40, limit: 30, viewer });
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
    const args = { query: { text: 'red foks' }, filter: filter(), limit: 50, viewer };
    await withCandidateCache('images', source, 'user')({ ...args, offset: 0 });
    service.correctedQuery = 'red fox';
    await withCandidateCache('images', source, 'user')({ ...args, offset: 100 });

    const spanning = await withCandidateCache('images', source, 'user')({ ...args, offset: 80 });
    expect(spanning.correctedQuery).toBe('red fox');
    expect(calls).toEqual([0, 100, 0, 100]);
  });

  it('makes one call for identical searches in flight together', async () => {
    const { source, calls } = rankedSource();
    // Separate wrappers are separate requests: only the pod-wide single-flight can join them.
    const search = () => withCandidateCache('images', source, 'user');
    const args = { query: { text: 'fox' }, filter: filter(), offset: 0, limit: 50, viewer };
    await Promise.all([search()(args), search()(args), search()(args)]);
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
        viewer,
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
        viewer,
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

describe('withCandidateCache and the query guard', () => {
  const flagged = {
    outcome: 'flag' as const,
    rules: ['block:rule_a'],
    mode: 'shadow',
    version: 'v1',
  };
  function guardedSource() {
    let calls = 0;
    const source: CandidateSource = async ({ offset, limit }) => {
      calls++;
      return { ids: Array.from({ length: limit }, (_, i) => offset + i + 1), guard: flagged };
    };
    return { source, calls: () => calls };
  }
  const status = (key: string) => async (): Promise<GuardStatus> => ({
    key,
    withholdResults: null,
  });
  const run = (search: CandidateSource) =>
    search({ query: { text: 'fox' }, filter: filter(), offset: 0, limit: 50, viewer });

  it("answers a cache hit with the guard's verdict from the original search", async () => {
    h.auditFlag = true;
    const { source, calls } = guardedSource();
    const first = await run(withCandidateCache('images', source, 'user', status('shadow:v1')));
    const again = await run(withCandidateCache('images', source, 'user', status('shadow:v1')));
    expect(first).toMatchObject({ guard: flagged, cacheHit: false });
    expect(again).toMatchObject({ guard: flagged, cacheHit: true });
    expect(calls()).toBe(1);
  });

  it('stops serving blocks once the guard changes mode or version', async () => {
    h.auditFlag = true;
    const { source, calls } = guardedSource();
    await run(withCandidateCache('images', source, 'user', status('shadow:v1')));
    await run(withCandidateCache('images', source, 'user', status('enforce:v1')));
    await run(withCandidateCache('images', source, 'user', status('enforce:v2')));
    expect(calls()).toBe(3);
  });

  it('does not cache a block judged by an artifact named `none` under no artifact', async () => {
    h.auditFlag = true;
    const noArtifact = status(parseGuardStatus({ mode: 'shadow', version: null }).key);
    let calls = 0;
    const source: CandidateSource = async ({ offset, limit }) => {
      calls++;
      return {
        ids: Array.from({ length: limit }, (_, i) => offset + i + 1),
        guard: { ...flagged, version: 'none' },
      };
    };
    await run(withCandidateCache('images', source, 'user', noArtifact));
    const again = await run(withCandidateCache('images', source, 'user', noArtifact));
    expect(again.cacheHit).toBe(false);
    expect(calls).toBe(2);
  });

  it('does not cache a block under a mode other than the one that judged it', async () => {
    h.auditFlag = true;
    const { source, calls } = guardedSource();
    // The pod's status read still says enforce; the replica that answered judged in shadow.
    await run(withCandidateCache('images', source, 'user', status('enforce:v1')));
    const again = await run(withCandidateCache('images', source, 'user', status('enforce:v1')));
    expect(again.cacheHit).toBe(false);
    expect(calls()).toBe(2);
  });

  const withOutcome = (outcome: string) => {
    let calls = 0;
    const source: CandidateSource = async ({ offset, limit }) => {
      calls++;
      return {
        ids: Array.from({ length: limit }, (_, i) => offset + i + 1),
        guard: { outcome, rules: [], mode: 'enforce', version: 'v1' } as GuardRead,
      };
    };
    return { source, calls: () => calls };
  };

  it.each(['unknown', 'unavailable', 'mismatch', 'error', 'a-value-added-later'])(
    "does not cache a block whose guard reached no verdict ('%s')",
    async (outcome) => {
      h.auditFlag = true;
      const { source, calls } = withOutcome(outcome);
      await run(withCandidateCache('images', source, 'user', status('enforce:v1')));
      const again = await run(withCandidateCache('images', source, 'user', status('enforce:v1')));
      expect(again.cacheHit).toBe(false);
      expect(calls()).toBe(2);
    }
  );

  it.each(['pass', 'flag'])("caches a block the guard judged ('%s')", async (outcome) => {
    h.auditFlag = true;
    const { source, calls } = withOutcome(outcome);
    await run(withCandidateCache('images', source, 'user', status('enforce:v1')));
    const again = await run(withCandidateCache('images', source, 'user', status('enforce:v1')));
    expect(again.cacheHit).toBe(true);
    expect(calls()).toBe(1);
  });

  it('caches a block no guard judged, such as a search by image', async () => {
    h.auditFlag = true;
    let calls = 0;
    const source: CandidateSource = async ({ offset, limit }) => {
      calls++;
      return {
        ids: Array.from({ length: limit }, (_, i) => offset + i + 1),
        guard: { outcome: 'none', rules: [], mode: '', version: null },
      };
    };
    await run(withCandidateCache('images', source, 'user', status('enforce:v1')));
    const again = await run(withCandidateCache('images', source, 'user', status('enforce:v1')));
    expect(again.cacheHit).toBe(true);
    expect(calls).toBe(1);
  });

  it('goes to the service every time while the guard status is unreadable', async () => {
    h.auditFlag = true;
    const { source, calls } = guardedSource();
    await run(withCandidateCache('images', source, 'user', status('unknown')));
    const again = await run(withCandidateCache('images', source, 'user', status('unknown')));
    expect(again.cacheHit).toBe(false);
    expect(calls()).toBe(2);
  });

  it('with the flag off, keeps the keys it had and never reads the status', async () => {
    const { source, calls } = guardedSource();
    const readStatus = vi.fn(status('shadow:v1'));
    await run(withCandidateCache('images', source, 'user', readStatus));
    await run(withCandidateCache('images', source, 'user', readStatus));
    expect(calls()).toBe(1);
    expect(readStatus).not.toHaveBeenCalled();
  });
});
