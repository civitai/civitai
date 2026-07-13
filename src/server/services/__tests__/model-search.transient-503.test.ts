import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit test for the transient-error widening in resolveModelSearchIds (the Meili
 * pre-step behind /api/v1/models?query=). Before the fix its catch only
 * converted civitai's own MeiliCallTimeoutError → ModelSearchMeiliTimeoutError;
 * every OTHER transient Meili error (the SDK's own MeiliSearchCommunicationError
 * 408/429/5xx, gateway 502/503/504, a network drop) fell through `throw e` as a
 * raw Error → an unhandled HTTP 500 in the REST handler. The fix widens the
 * catch to isTransientMeiliError so a transient brownout becomes the retryable
 * ModelSearchMeiliTimeoutError signal. A non-transient error (malformed filter
 * 400 / real app bug) must NOT be converted and must rethrow unchanged.
 */

const { mockSearch } = vi.hoisted(() => ({ mockSearch: vi.fn() }));

// Keep the REAL isTransientMeiliError + MeiliCallTimeoutError (the classifier
// under test); only drive the connection surface: searchClient.index().search
// is our controllable mock, and withMeili is a passthrough so whatever `search`
// rejects with reaches resolveModelSearchIds' catch unchanged.
vi.mock('~/server/meilisearch/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/meilisearch/client')>();
  return {
    ...actual,
    searchClient: { index: () => ({ search: mockSearch }) },
    withMeili: (_op: string, fn: () => unknown) => fn(),
  };
});

// Heavy collaborators the service imports at module load but resolveModelSearchIds
// never drives — mocked so the import stays light (mirrors model-search.image-filter).
vi.mock('~/server/services/model.service', () => ({ getModelsWithVersions: vi.fn() }));
vi.mock('~/server/services/file.service', () => ({ getDownloadFilename: vi.fn() }));
vi.mock('~/client-utils/cf-images-utils', () => ({ getEdgeUrl: (u: string) => u }));
vi.mock('~/server/common/model-helpers', () => ({ createModelFileDownloadUrl: vi.fn() }));

const makeCommunicationError = (statusCode: number) => {
  const e = new Error(statusCode === 408 ? 'Request Timeout' : 'Service Unavailable') as Error & {
    name: string;
    statusCode: number;
  };
  e.name = 'MeiliSearchCommunicationError';
  e.statusCode = statusCode;
  return e;
};

async function callResolve() {
  const { resolveModelSearchIds } = await import('~/server/services/model-search.service');
  return resolveModelSearchIds({ query: 'foo', cursor: undefined, limit: 10, browsingLevel: 1 });
}

describe('resolveModelSearchIds — transient Meili error → ModelSearchMeiliTimeoutError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: returns searchIds + nextCursor', async () => {
    // limit+1 hits → hasMore true → one page + a next cursor.
    mockSearch.mockResolvedValue({ hits: Array.from({ length: 11 }, (_, i) => ({ id: i + 1 })) });
    const res = await callResolve();
    expect(res.searchIds).toHaveLength(10);
    expect(res.nextCursor).toBe('10');
  });

  it('converts civitai MeiliCallTimeoutError → ModelSearchMeiliTimeoutError', async () => {
    const { MeiliCallTimeoutError } = await import('~/server/meilisearch/client');
    const { ModelSearchMeiliTimeoutError } = await import(
      '~/server/services/model-search.service'
    );
    mockSearch.mockRejectedValue(new MeiliCallTimeoutError('timeout'));
    await expect(callResolve()).rejects.toBeInstanceOf(ModelSearchMeiliTimeoutError);
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'converts a raw SDK MeiliSearchCommunicationError(statusCode=%i) → ModelSearchMeiliTimeoutError (the widening)',
    async (status) => {
      const { ModelSearchMeiliTimeoutError } = await import(
        '~/server/services/model-search.service'
      );
      mockSearch.mockRejectedValue(makeCommunicationError(status));
      await expect(callResolve()).rejects.toBeInstanceOf(ModelSearchMeiliTimeoutError);
    }
  );

  it('does NOT convert a non-transient SDK 400 (malformed filter) — rethrows the original error', async () => {
    const { ModelSearchMeiliTimeoutError } = await import(
      '~/server/services/model-search.service'
    );
    const original = makeCommunicationError(400);
    mockSearch.mockRejectedValue(original);
    await expect(callResolve()).rejects.toBe(original);
    await expect(callResolve()).rejects.not.toBeInstanceOf(ModelSearchMeiliTimeoutError);
  });

  it('does NOT convert a generic app error (null deref) — rethrows the original error', async () => {
    const { ModelSearchMeiliTimeoutError } = await import(
      '~/server/services/model-search.service'
    );
    const original = new Error('cannot read properties of undefined');
    mockSearch.mockRejectedValue(original);
    await expect(callResolve()).rejects.toBe(original);
    await expect(callResolve()).rejects.not.toBeInstanceOf(ModelSearchMeiliTimeoutError);
  });
});
