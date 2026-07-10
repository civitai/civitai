import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * DIRECT test of the transient-error widening in getModelsRaw — the Meili search
 * behind the tRPC model.getAll path (getModelsInfiniteHandler ->
 * getModelsWithImagesAndModelVersions -> getModelsRaw). Its catch previously
 * only converted civitai's own MeiliCallTimeoutError to a retryable TRPCError
 * SERVICE_UNAVAILABLE; every OTHER transient Meili error (the SDK's own
 * MeiliSearchCommunicationError 408/429/5xx, gateway 502/503/504, network drop)
 * fell through `throw err` as a raw Error -> getModelsInfiniteHandler's
 * throwDbError wrapped it as TRPCError INTERNAL_SERVER_ERROR -> a 500 (invisible
 * in Axiom). The fix widens the catch to isTransientMeiliError so a transient
 * brownout surfaces as SERVICE_UNAVAILABLE (503). A non-transient error is NOT
 * converted and rethrows unchanged.
 *
 * This drives the REAL getModelsRaw. model.service transitively imports the
 * `event-engine-common` submodule ONLY through image.service (value import) +
 * flipt/client (isFlipt) — both of which are used LATER than the Meili catch, so
 * stubbing them (a) breaks the missing-submodule import chain that would
 * otherwise block loading model.service in the unit env and (b) never affects
 * the throw path under test (the catch fires before either is reached).
 */

const { mockSearch } = vi.hoisted(() => ({ mockSearch: vi.fn() }));

// Keep the REAL isTransientMeiliError + MeiliCallTimeoutError (the classifier the
// widened catch calls); only drive the connection surface. withMeili is a
// passthrough so whatever `search` rejects with reaches getModelsRaw's catch
// unchanged.
vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/meilisearch/client')>();
  return {
    ...actual,
    searchClient: { index: () => ({ search: mockSearch }) },
    withMeili: (_op: string, fn: () => unknown) => fn(),
  };
});

// Break the `event-engine-common` submodule import chain (absent from the
// checkout → blocks importing the real model.service otherwise) + keep the
// import light. All stubbed members are only reached AFTER the Meili catch.
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));

// Stub the DB/redis surfaces model.service imports. None are reached on the
// throw path (the Meili catch fires before any query), but importing the REAL
// modules instantiates a Prisma client that fires a query at module load and
// throws an UNHANDLED PrismaClientInitializationError on this host (no
// linux-nixos query engine) — a false-positive vector Vitest flags. Stubbing
// them keeps the run clean without touching the code under test.
vi.mock('~/server/db/client', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbWrite: {} }));
// Keep the REAL REDIS_KEYS (the ~/server/redis/caches module reads nested keys
// like REDIS_KEYS.*.RESOURCE_DATA at module load), but stub the redis/sysRedis
// CLIENTS so no real connection opens. importOriginal here does not connect
// (the client factory is guarded); it only gives us the key definitions.
vi.mock('~/server/redis/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/redis/client')>();
  return {
    ...actual,
    redis: { packed: { get: async () => null, set: async () => undefined } },
    sysRedis: {},
  };
});

const makeCommunicationError = (statusCode: number) => {
  const e = new Error(statusCode === 408 ? 'Request Timeout' : 'Service Unavailable') as Error & {
    name: string;
    statusCode: number;
  };
  e.name = 'MeiliSearchCommunicationError';
  e.statusCode = statusCode;
  return e;
};

// Minimal input that reaches the Meili block: `if (query && searchClient &&
// (!ids || ids.length === 0))`. Only query/take/browsingLevel/ids are read
// before the throw; the rest are optional. Cast — the full GetAllModelsOutput
// shape is irrelevant to the catch path.
async function callGetModelsRaw() {
  const { getModelsRaw } = await import('~/server/services/model.service');
  return getModelsRaw({
    input: { query: 'foo', browsingLevel: 1, take: 10 } as never,
  });
}

describe('getModelsRaw — transient Meili error → TRPCError SERVICE_UNAVAILABLE (tRPC model.getAll path)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'converts a raw SDK MeiliSearchCommunicationError(statusCode=%i) → TRPCError SERVICE_UNAVAILABLE (the widening; fails against the narrow instanceof-only catch)',
    async (status) => {
      mockSearch.mockRejectedValue(makeCommunicationError(status));
      await expect(callGetModelsRaw()).rejects.toMatchObject({
        name: 'TRPCError',
        code: 'SERVICE_UNAVAILABLE',
      });
    }
  );

  it('preserves civitai MeiliCallTimeoutError → TRPCError SERVICE_UNAVAILABLE', async () => {
    const { MeiliCallTimeoutError } = await import('~/server/meilisearch/client');
    mockSearch.mockRejectedValue(new MeiliCallTimeoutError('timeout'));
    await expect(callGetModelsRaw()).rejects.toMatchObject({
      name: 'TRPCError',
      code: 'SERVICE_UNAVAILABLE',
    });
  });

  it('does NOT convert a non-transient SDK 400 (malformed filter) — rethrows the raw error, NOT a TRPCError', async () => {
    const original = makeCommunicationError(400);
    mockSearch.mockRejectedValue(original);
    await expect(callGetModelsRaw()).rejects.toBe(original);
    await expect(callGetModelsRaw()).rejects.not.toBeInstanceOf(TRPCError);
  });

  it('does NOT convert a generic app error (null deref) — rethrows the raw error, NOT a TRPCError', async () => {
    const original = new Error('cannot read properties of undefined');
    mockSearch.mockRejectedValue(original);
    await expect(callGetModelsRaw()).rejects.toBe(original);
    await expect(callGetModelsRaw()).rejects.not.toBeInstanceOf(TRPCError);
  });
});
