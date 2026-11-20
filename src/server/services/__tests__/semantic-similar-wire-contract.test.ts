import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type { CandidateFilter } from '~/server/services/semantic-search-client';

/**
 * The request search-by-upload sends to the search service's POST /v1/similar. The fields and
 * bounds below are the search service's SimilarRequest schema: a renamed or dropped field there
 * fails the search for every upload, and nothing else here would notice.
 */
const SIMILAR_REQUEST_FIELDS = [
  'collection',
  'image_url',
  'filter',
  'limit',
  'offset',
  'with_payload',
  'browsing_levels',
];
const SERVICE_MAX = { limit: 100, offset: 2000 };

const h = vi.hoisted(() => ({ auditFlag: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isFlipt: async (flag: string) => flag === 'semantic-search-audit' && h.auditFlag,
}));

const { searchServiceSource, MAX_CANDIDATE_LIMIT, MAX_CANDIDATE_OFFSET } = await import(
  '~/server/services/semantic-search-client'
);

const BLOB = 'https://orchestration.civitai.com/v2/consumer/blobs/b1';
const filter: CandidateFilter = { gate: { kind: 'level', nsfwLevels: [1, 2] } };
let sent: { url: string; init: RequestInit; body: Record<string, unknown> }[];

beforeEach(() => {
  setEnv({ SEARCH_SERVICE_URL: 'http://search.test/' });
  h.auditFlag = false;
  sent = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    return Response.json({
      hits: [
        { id: 3, score: 0.9 },
        { id: '4', score: 0.8 },
      ],
      guard: { refused: false },
      timings: {},
    });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const searchByUpload = () =>
  searchServiceSource('images')({
    query: { imageUrl: BLOB },
    filter,
    offset: 40,
    limit: 20,
    viewer: { isModerator: true },
  });

describe('POST /v1/similar, as search-by-upload sends it', () => {
  it('posts the image URL, collection, filter and page to /v1/similar', async () => {
    await searchByUpload();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('http://search.test/v1/similar');
    expect(sent[0].init.method).toBe('POST');
    expect(sent[0].body).toEqual({
      collection: 'images',
      image_url: BLOB,
      filter: expect.objectContaining({ must: expect.any(Array) }),
      offset: 40,
      limit: 20,
    });
  });

  it('adds the browsing levels when auditing, and sends only fields the service declares', async () => {
    h.auditFlag = true;
    await searchByUpload();
    expect(sent[0].body.browsing_levels).toEqual([1, 2]);
    expect(Object.keys(sent[0].body).filter((k) => !SIMILAR_REQUEST_FIELDS.includes(k))).toEqual(
      []
    );
  });

  it('waits the longer similar-image timeout, since the service fetches and embeds the image', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await searchByUpload();
    expect(timeout).toHaveBeenCalledWith(35_000);
  });

  it('reads the hit ids, numeric or string, as numbers', async () => {
    await expect(searchByUpload()).resolves.toMatchObject({ ids: [3, 4] });
  });

  it("never pages past the service's limits", () => {
    expect(MAX_CANDIDATE_LIMIT).toBeLessThanOrEqual(SERVICE_MAX.limit);
    expect(MAX_CANDIDATE_OFFSET).toBeLessThanOrEqual(SERVICE_MAX.offset);
  });
});
