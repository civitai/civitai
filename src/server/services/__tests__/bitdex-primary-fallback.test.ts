import { beforeEach, describe, expect, it, vi } from 'vitest';

// A BitDex query that FAILS and one that legitimately matches nothing both reach
// fetchBitdexPrimary as an empty accumulation. When the own-excluded second pass is
// running (logged-in caller, no userId filter, first page) that empty accumulation slips
// past the `!accumulated.length && !ownExcludedPromise` guard, so getImagesFromSearch
// receives a truthy `{ data: [] }`, never consults Meilisearch, and the user gets a blank
// feed instead of a degraded one.
//
// The same null also comes back for queries that CANNOT match — an empty follow set, an
// unknown username — which short-circuit before any request. Those must not fall back to
// Meili, and must not reach the own-excluded merge either: a Following feed with nobody
// followed would otherwise render as the viewer's own private and blocked images.
//
// Pinned here, end to end through getImagesFromSearch:
//   - main pass FAILED, nothing accumulated → falls through to Meili (source 'meili')
//   - main pass UNSATISFIABLE → empty BitDex page, own-excluded content not merged
//   - main pass returned a legitimate empty 200 → serves the empty BitDex page
//
// Minimal-seam mocking follows image-feed-clickhouse-failsoft.test.ts: stub the infra
// clients and env so importing image.service doesn't boot anything real.

const {
  queryBitdexOutcomeMock,
  queryBitdexMock,
  readUserMock,
  writeUserMock,
  recordBitdexErrorMock,
} = vi.hoisted(() => ({
  queryBitdexOutcomeMock: vi.fn(),
  queryBitdexMock: vi.fn(),
  readUserMock: vi.fn(),
  writeUserMock: vi.fn(),
  recordBitdexErrorMock: vi.fn(),
}));

vi.mock('~/server/bitdex/compare', () => ({
  recordBitdexError: recordBitdexErrorMock,
  compareBitdexResults: vi.fn(),
}));

vi.mock('~/server/bitdex/client', () => ({
  queryBitdex: queryBitdexMock,
  queryBitdexOutcome: queryBitdexOutcomeMock,
  fetchBitdexDocuments: vi.fn(),
}));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

// userEngagement backs the `followed` short-circuit; an empty follow set is the
// unsatisfiable case exercised below. user.findUnique backs the username lookup, which
// reads the replica and falls through to the primary.
vi.mock('~/server/db/client', () => ({
  dbRead: {
    userEngagement: { findMany: vi.fn(async () => [] as unknown[]) },
    user: { findUnique: readUserMock },
  },
  dbWrite: { user: { findUnique: writeUserMock } },
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/client', () => {
  const make = (): any => new Proxy(() => 'k', { get: () => make() });
  const keyProxy = make();
  return {
    redis: {
      get: vi.fn().mockResolvedValue('[]'),
      set: vi.fn().mockResolvedValue(undefined),
      packed: { get: vi.fn(), set: vi.fn() },
    },
    sysRedis: {},
    REDIS_KEYS: keyProxy,
    REDIS_SYS_KEYS: keyProxy,
  };
});

// NB: do NOT mock '~/server/flipt/client' — a catch-all Proxy mock wedges image.service's
// module-load import. The real module loads fine and getFliptBoolean fail-opens to false.

import { getImagesFromBitdexPreFilter, getImagesFromSearch } from '../image.service';

// currentUserId with no userId filter and no cursor is exactly the shape that starts the
// own-excluded second pass — the condition under which the blank feed reproduced.
const baseInput = {
  limit: 10,
  browsingLevel: 1,
  currentUserId: 500,
  bitdexMode: 'primary',
} as any;

const emptyOk = {
  status: 'ok' as const,
  result: { ids: [], total_matched: 0, documents: [], elapsed_us: 1 },
};

describe('BitDex primary fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Meilisearch is unconfigured here, so the fall-through path returns an empty page
    // tagged `source: 'meili'` — enough to observe WHICH backend answered.
    queryBitdexMock.mockResolvedValue(null);
  });

  it('falls through to Meili when the main BitDex query fails', async () => {
    queryBitdexOutcomeMock.mockResolvedValue({ status: 'failed' });

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('meili');
  });

  it('serves the empty BitDex page when the main query legitimately matches nothing', async () => {
    queryBitdexOutcomeMock.mockResolvedValue(emptyOk);

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('bitdex');
    expect(result.data).toEqual([]);
  });

  it("serves an empty feed — not the viewer's own excluded content — when the query cannot match", async () => {
    // Following nobody short-circuits before any request is made. The own-excluded pass
    // still runs and still returns the viewer's private/blocked/unpublished images; those
    // must not become the feed.
    queryBitdexOutcomeMock.mockResolvedValue(emptyOk);
    queryBitdexMock.mockResolvedValue({
      ids: [99],
      total_matched: 1,
      elapsed_us: 1,
      documents: [
        {
          id: 99,
          url: 'own-private.jpeg',
          nsfwLevel: 1,
          userId: 500,
          availability: 'Private',
          postId: 7,
          sortAt: 1_700_000_000,
        },
      ],
    });

    const result = await getImagesFromSearch({ ...baseInput, followed: true });

    expect(result.source).toBe('bitdex');
    expect(result.data).toEqual([]);
  });

  it('still serves BitDex results when a later pagination pass fails', async () => {
    queryBitdexOutcomeMock.mockResolvedValueOnce({
      status: 'ok',
      result: {
        ids: [1],
        total_matched: 1,
        cursor: { sortAt: 1 },
        elapsed_us: 1,
        documents: [
          {
            id: 1,
            url: 'a.jpeg',
            nsfwLevel: 1,
            userId: 7,
            sortAt: 1_700_000_000,
            publishedAt: 1_700_000_000,
          },
        ],
      },
    });
    queryBitdexOutcomeMock.mockResolvedValue({ status: 'failed' });

    const result = await getImagesFromSearch(baseInput);

    expect(result.source).toBe('bitdex');
    expect(result.data.map((d: { id: number }) => d.id)).toEqual([1]);
  });
});

// The username lookup is the one short-circuit that is NOT an unsatisfiable query: an
// unknown username is an error everywhere else in the service (getAllImages,
// getImagesFromSearchPreFilter), and classifying it as "legitimately empty" here would
// have turned a dead profile into a silent empty gallery. It also has to survive replica
// lag, or a freshly created user's own profile 404s.
describe('BitDex primary username lookup', () => {
  const withUsername = { ...baseInput, username: 'someone' };

  beforeEach(() => {
    vi.clearAllMocks();
    queryBitdexOutcomeMock.mockResolvedValue(emptyOk);
  });

  it('throws NotFound for an unknown username rather than serving an empty page', async () => {
    readUserMock.mockResolvedValue(null);
    writeUserMock.mockResolvedValue(null);

    await expect(getImagesFromBitdexPreFilter(withUsername)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('falls through to the primary when the replica has not caught up', async () => {
    readUserMock.mockResolvedValue(null);
    writeUserMock.mockResolvedValue({ id: 77 });

    await expect(getImagesFromBitdexPreFilter(withUsername)).resolves.toBeTruthy();
    expect(writeUserMock).toHaveBeenCalled();
  });

  it('does not touch the primary when the replica has the user', async () => {
    readUserMock.mockResolvedValue({ id: 77 });

    await expect(getImagesFromBitdexPreFilter(withUsername)).resolves.toBeTruthy();
    expect(writeUserMock).not.toHaveBeenCalled();
  });

  // The NOT_FOUND has to reach the client. Primary mode's catch treats a throw as "BitDex
  // is broken, try Meili", which would send a rejected request down a second backend to
  // reach the same 404 and count a client error against BitDex's health.
  it('propagates NotFound out of primary mode instead of falling through to Meili', async () => {
    readUserMock.mockResolvedValue(null);
    writeUserMock.mockResolvedValue(null);

    // Meili is unconfigured here, so consulting it resolves with `source: 'meili'`.
    // Rejecting is therefore the observable proof that it was never consulted.
    await expect(getImagesFromSearch({ ...withUsername })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(recordBitdexErrorMock).not.toHaveBeenCalled();
  });

  // Guards the other half of the narrowing. This has to REJECT rather than resolve
  // `{ status: 'failed' }` — a resolved failure never throws, so it would exercise the
  // accumulation guard instead of the catch and pass no matter what the catch does.
  it('still falls through to Meili for a non-TRPC failure', async () => {
    readUserMock.mockResolvedValue({ id: 77 });
    queryBitdexOutcomeMock.mockRejectedValue(new Error('boom'));

    const result = await getImagesFromSearch({ ...withUsername });

    expect(result.source).toBe('meili');
    expect(recordBitdexErrorMock).toHaveBeenCalled();
  });
});
