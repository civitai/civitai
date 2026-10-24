import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as FliptClient from '~/server/flipt/client';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as BlockScopeMiddleware from '~/server/middleware/block-scope.middleware';
import type * as FileService from '~/server/services/file.service';
import type * as PaginationHelpers from '~/server/utils/pagination-helpers';
import type { BlockTokenClaims } from '~/server/middleware/block-scope.middleware';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * SEAM tests for `owner=mine` and `modelVersionIds` on /api/v1/blocks/models.
 *
 * `models-endpoint.test.ts` mocks the whole search service, so it proves only what the handler
 * HANDS the service. These drive the REAL handler → `runModelSearch` → `getModelsWithVersions` →
 * `getModelsRaw` chain, stubbing only I/O: the Meili client, the raw model query, and the caches.
 * What a test here observes is either the Meili `filter` argument, the SQL `getModelsRaw` built,
 * or the response body.
 *
 * The raw model query is a FAKE that understands exactly one predicate — the owner clause
 * `<alias>."userId" = $n`, on either `m` (Model) or `mm` (ModelMetric), which both hold the owner
 * (not the `OR … "userId" = $n` arms of the poi/minor/tag gates). It filters rows by the id
 * BOUND there, so a test pins the filter's effect, not which column spells it. Everything else in
 * the WHERE is ignored, so these tests say nothing about the rest of the SQL.
 */

// Pairwise distinct, and distinct from every other literal in this file.
const OWNER_ID = 7311;
const OTHER_ID = 5529;

const MINE_MODEL = 610;
const THEIRS_MODEL = 620;
// Versions of MINE_MODEL, newest first (index order). The Private one is newest on purpose: with
// only-the-latest-version shaping it would be the one shown.
const MINE_PRIVATE_V = 6101;
const MINE_PUBLIC_A = 6102;
const MINE_PUBLIC_B = 6103;
const MINE_DRAFT_V = 6104;
const THEIRS_PUBLIC_V = 6201;
const PUBLIC_BASE = 'SD 1.5';
const PRIVATE_ONLY_BASE = 'SDXL 1.0';

const {
  mockSearch,
  mockCancellableQuery,
  mockGetFilesForModelVersionCache,
  mockDataForModelsFetch,
  capturedSql,
} = vi.hoisted(() => ({
  mockSearch: vi.fn(),
  mockCancellableQuery: vi.fn(),
  mockGetFilesForModelVersionCache: vi.fn(),
  mockDataForModelsFetch: vi.fn(),
  capturedSql: [] as { text: string; values: unknown[] }[],
}));

const claimsBox: { claims: BlockTokenClaims | undefined } = { claims: undefined };

vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => ({
  ...(await importOriginal<typeof BlockScopeMiddleware>()),
  withBlockScope: (handler: any) => (req: any, res: any) => {
    req.blockClaims = claimsBox.claims;
    return handler(req, res);
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (handler: any) => handler }));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({
  checkBlockCatalogRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: () => ({ countryCode: 'US', regionCode: null, fullLocationCode: 'US' }),
  isRegionRestricted: () => false,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));
vi.mock('~/server/utils/pagination-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof PaginationHelpers>()),
  getNextPage: () => ({ baseUrl: { origin: 'https://civitai.com' }, nextPage: undefined }),
}));

vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => ({ search: mockSearch }) },
  withMeili: (_op: string, fn: () => unknown) => fn(),
}));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileService>()),
  getDownloadFilename: () => 'model.safetensors',
}));

// I/O under getModelsWithVersions — the set model.service.vae-append-no-mutation.test.ts stubs,
// except the db and redis clients, which come from the canonical shared mocks
// (docs/testing/shared-module-mocks.md).
vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: { cancellableQuery: mockCancellableQuery },
  pgDbWrite: {},
  pgDbReadLong: {},
}));
vi.mock('~/server/services/model-file.service', () => ({
  getFilesForModelVersionCache: mockGetFilesForModelVersionCache,
  deleteFilesForModelVersionCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn().mockResolvedValue({}),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn().mockResolvedValue(false),
}));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/services/paid-access.service', () => ({
  getPaidAccess: vi.fn(),
  getPublicPaidAccessForModelVersions: vi.fn().mockResolvedValue({}),
  getModelPaidAccessGates: vi.fn().mockResolvedValue(new Map()),
  bustPaidAccessCache: vi.fn(),
  bustModelSaleCache: vi.fn(),
}));
vi.mock('~/server/services/creator-program.service', () => ({
  getValidCreatorMembershipMap: vi.fn().mockResolvedValue(new Map()),
  getUserMetricPrivacyDefaultsMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock('~/server/services/user.service', () => ({
  deleteBasicDataForUser: vi.fn(),
  getCosmeticsForUsers: vi.fn().mockResolvedValue({}),
  getProfilePicturesForUsers: vi.fn().mockResolvedValue({}),
}));
vi.mock('~/server/services/cosmetic.service', () => ({ getCosmeticsForEntity: vi.fn() }));
// Must track model.service's own import list from this module: a missing name throws during
// module evaluation and the file collects ZERO tests.
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { fetch: mockDataForModelsFetch },
  modelVersionPublicDonationGoalsCache: { fetch: vi.fn(), bust: vi.fn() },
  modelTagCache: { fetch: vi.fn(), bust: vi.fn() },
  modelVotableTagsCache: { fetch: vi.fn(), bust: vi.fn() },
  userBasicCache: { fetch: vi.fn().mockResolvedValue({}), bust: vi.fn() },
  userModelCountCache: { fetch: vi.fn(), bust: vi.fn() },
}));

// Static import: model.service's cold transform belongs in collection, not in one test's budget
// (see get-models-raw.transient-503.test.ts).
import handler from '~/pages/api/v1/blocks/models';
import toolsHandler from '~/pages/api/v1/blocks/tools';
import { resolveModelSearchIds } from '~/server/services/model-search.service';

const MODEL_ROWS = [
  { id: MINE_MODEL, userId: OWNER_ID },
  { id: THEIRS_MODEL, userId: OTHER_ID },
];

function version(
  id: number,
  index: number,
  availability: 'Public' | 'Private',
  status: 'Published' | 'Draft' = 'Published',
  baseModel = PUBLIC_BASE
) {
  return {
    id,
    index,
    name: `v${id}`,
    status,
    baseModel,
    nsfwLevel: 1,
    availability,
    covered: true,
    trainingStatus: null,
    earlyAccessTimeFrame: 0,
  };
}

const MODEL_DATA: Record<number, unknown> = {
  [MINE_MODEL]: {
    modelId: MINE_MODEL,
    hashes: [],
    tags: [],
    versions: [
      // Its own base model, so a surface that shows only the latest version's base model (the
      // block tool's projection) reveals whether this version leaked.
      version(MINE_PRIVATE_V, 0, 'Private', 'Published', PRIVATE_ONLY_BASE),
      version(MINE_PUBLIC_A, 1, 'Public'),
      version(MINE_PUBLIC_B, 2, 'Public'),
      // Public but unpublished: must stay out on every path (Published-only).
      version(MINE_DRAFT_V, 3, 'Public', 'Draft'),
    ],
  },
  [THEIRS_MODEL]: {
    modelId: THEIRS_MODEL,
    hashes: [],
    tags: [],
    versions: [version(THEIRS_PUBLIC_V, 0, 'Public')],
  },
};

// The owner clause on either alias, excluding the `... OR <alias>."userId" = $n` owner-exemption
// arms. `\b` stops the second `m` of `mm` matching on its own, past the lookbehind.
const OWNER_CLAUSE = /(?<!OR )\bm{1,2}\."userId" = \$(\d+)/g;

/** Values bound into every owner clause of the captured model query. */
function boundOwnerIds(): unknown[] {
  expect(capturedSql).toHaveLength(1);
  const { text, values } = capturedSql[0];
  return [...text.matchAll(OWNER_CLAUSE)].map((m) => values[Number(m[1]) - 1]);
}

function primeIo() {
  capturedSql.length = 0;
  mockCancellableQuery.mockImplementation(async (query: { text: string; values: unknown[] }) => {
    capturedSql.push(query);
    // The fake honours the owner clause ONLY — see the file header.
    const owners = [...query.text.matchAll(OWNER_CLAUSE)].map(
      (m) => query.values[Number(m[1]) - 1]
    );
    // Honour the search-id predicate too, so a query response mirrors Meili's hits.
    const idsMatch = query.text.match(/mm\."modelId" IN \(([^)]*)\)/);
    const idParams = idsMatch
      ? [...idsMatch[1].matchAll(/\$(\d+)/g)].map((m) => query.values[Number(m[1]) - 1])
      : undefined;
    const rows = MODEL_ROWS.filter(
      (r) =>
        owners.every((o) => o === r.userId) && (idParams === undefined || idParams.includes(r.id))
    ).map((r) => ({
      ...r,
      name: `model ${r.id}`,
      cursorId: null,
      meta: null,
      rank: {
        downloadCount: 0,
        thumbsUpCount: 0,
        thumbsDownCount: 0,
        commentCount: 0,
        collectedCount: 0,
        tippedAmountCount: 0,
      },
    }));
    return { result: async () => rows, cancel: async () => undefined };
  });
  mockDataForModelsFetch.mockImplementation(async (ids: number[]) =>
    Object.fromEntries(ids.filter((id) => MODEL_DATA[id]).map((id) => [id, MODEL_DATA[id]]))
  );
  mockGetFilesForModelVersionCache.mockImplementation(async (ids: number[]) =>
    Object.fromEntries(
      ids.map((id) => [
        id,
        {
          modelVersionId: id,
          files: [
            {
              id: id * 10,
              name: `f${id}.safetensors`,
              type: 'Model',
              modelVersionId: id,
              metadata: {},
              hashes: [],
              visibility: 'Public',
            },
          ],
        },
      ])
    )
  );
  redisMock.redis.packed.get.mockImplementation(async () => null);
  redisMock.redis.packed.set.mockImplementation(async () => undefined);
  dbMock.dbRead.$queryRaw.mockResolvedValue([] as never);
  dbMock.dbRead.recommendedResource.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelFile.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelMetric.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelVersionMetric.findMany.mockResolvedValue([]);
  dbMock.dbRead.modelVersion.findMany.mockResolvedValue([]);
  mockSearch.mockResolvedValue({ hits: [{ id: MINE_MODEL }, { id: THEIRS_MODEL }] });
}

function claimsFor(sub: string): BlockTokenClaims {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub,
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk',
    appId: 'app',
    appBlockId: 'apb_test',
    blockInstanceId: 'bki_test',
    ctx: {},
    scopes: [],
  };
}

async function invoke(query: Record<string, unknown>) {
  return call(handler, {
    method: 'GET',
    query,
    headers: {},
    url: '/api/v1/blocks/models',
  });
}

/** POST a `search_models` call to /api/v1/blocks/tools. */
async function invokeSearchTool(args: Record<string, unknown>) {
  return call(toolsHandler, {
    method: 'POST',
    query: {},
    body: { name: 'search_models', arguments: args },
    headers: {},
    url: '/api/v1/blocks/tools',
  });
}

async function call(route: unknown, reqInit: Record<string, unknown>) {
  const req = reqInit as unknown as NextApiRequest;
  const res = {
    headers: {} as Record<string, unknown>,
    statusCode: undefined as number | undefined,
    body: undefined as any,
    setHeader(k: string, v: unknown) {
      this.headers[k] = v;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  await (route as (q: NextApiRequest, s: NextApiResponse) => Promise<void>)(
    req,
    res as unknown as NextApiResponse
  );
  return res;
}

type Item = { id: number; modelVersions: { id: number }[] };
const itemIds = (body: { items: Item[] }) => body.items.map((i) => i.id);
const versionIds = (body: { items: Item[] }, modelId: number) =>
  body.items.find((i) => i.id === modelId)?.modelVersions.map((v) => v.id);

function meiliFilter(): string[] {
  expect(mockSearch).toHaveBeenCalledTimes(1);
  return mockSearch.mock.calls[0][1].filter;
}

describe('/api/v1/blocks/models owner=mine — through the real search chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primeIo();
    claimsBox.claims = claimsFor(`user:${OWNER_ID}`);
  });

  it('CONTROL: without owner both owners come back and no owner clause is built', async () => {
    const res = await invoke({});
    expect(res.statusCode).toBe(200);
    expect(itemIds(res.body).sort()).toEqual([MINE_MODEL, THEIRS_MODEL]);
    expect(boundOwnerIds()).toEqual([]);
  });

  it("A1: returns only the subject's models", async () => {
    const res = await invoke({ owner: 'mine' });
    expect(res.statusCode).toBe(200);
    expect(itemIds(res.body)).toEqual([MINE_MODEL]);
    expect(boundOwnerIds()).toEqual([OWNER_ID]);
  });

  it("A1: a different subject gets that subject's models (the id is not hardcoded)", async () => {
    claimsBox.claims = claimsFor(`user:${OTHER_ID}`);
    const res = await invoke({ owner: 'mine' });
    expect(itemIds(res.body)).toEqual([THEIRS_MODEL]);
    expect(boundOwnerIds()).toEqual([OTHER_ID]);
  });

  it('A3: never returns a Private-availability version of the subject’s model on a text query', async () => {
    const res = await invoke({ owner: 'mine', query: 'anything' });
    expect(res.statusCode).toBe(200);
    expect(versionIds(res.body, MINE_MODEL)).toEqual([MINE_PUBLIC_A, MINE_PUBLIC_B]);
    expect(itemIds(res.body)).toEqual([MINE_MODEL]);
  });

  // Invariant guard: without a query the existing Public-version filter already applies.
  it('A3 (invariant guard): …nor without a query', async () => {
    const res = await invoke({ owner: 'mine' });
    expect(versionIds(res.body, MINE_MODEL)).toEqual([MINE_PUBLIC_A, MINE_PUBLIC_B]);
  });

  it('A4: owner=mine + query puts `user.id = <subject>` in the Meili filter', async () => {
    await invoke({ owner: 'mine', query: 'anything' });
    const filter = meiliFilter();
    expect(filter).toContain(`user.id = ${OWNER_ID}`);
    // The maturity filter stays alongside it.
    expect(filter.some((f) => f.startsWith('nsfwLevel IN ['))).toBe(true);
  });

  it('A4 CONTROL: no owner → no user.id filter', async () => {
    await invoke({ query: 'anything' });
    expect(meiliFilter().some((f) => f.startsWith('user.id'))).toBe(false);
  });

  it('A6: a userId in the query never reaches the SQL or the Meili filter', async () => {
    const res = await invoke({
      owner: 'mine',
      query: 'anything',
      userId: String(OTHER_ID),
      username: 'someone-else',
    });
    expect(res.statusCode).toBe(200);
    expect(itemIds(res.body)).toEqual([MINE_MODEL]);
    expect(boundOwnerIds()).toEqual([OWNER_ID]);
    const filter = meiliFilter();
    expect(filter).toContain(`user.id = ${OWNER_ID}`);
    expect(filter.join(' ')).not.toContain(String(OTHER_ID));
    // The username lookup path was not taken.
    expect(dbMock.dbRead.user.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.user.findUnique).not.toHaveBeenCalled();
  });

  it('A2: an anonymous subject is refused before any query runs', async () => {
    claimsBox.claims = claimsFor('anon');
    const res = await invoke({ owner: 'mine', query: 'anything' });
    expect(res.statusCode).toBe(401);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(capturedSql).toHaveLength(0);
  });
});

describe('/api/v1/blocks/models modelVersionIds — through the real search chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primeIo();
    claimsBox.claims = claimsFor(`user:${OWNER_ID}`);
  });

  it('returns the models of the requested versions, narrowed to those versions', async () => {
    const res = await invoke({ modelVersionIds: `${MINE_PUBLIC_B},${THEIRS_PUBLIC_V}` });
    expect(res.statusCode).toBe(200);
    expect(versionIds(res.body, MINE_MODEL)).toEqual([MINE_PUBLIC_B]);
    expect(versionIds(res.body, THEIRS_MODEL)).toEqual([THEIRS_PUBLIC_V]);
    // The fake does not evaluate this clause, so pin its whole shape — including the
    // correlation, without which any model would match as soon as one listed version exists.
    const { text, values } = capturedSql[0];
    const clause = text.match(
      /EXISTS \(\s*SELECT 1 FROM "ModelVersion" mv\s*WHERE mv\."id" IN \(\$(\d+),\$(\d+)\)\s*AND mv\."modelId" = mm\."modelId"\s*\)/
    );
    expect(clause, text).not.toBeNull();
    expect([values[Number(clause![1]) - 1], values[Number(clause![2]) - 1]]).toEqual([
      MINE_PUBLIC_B,
      THEIRS_PUBLIC_V,
    ]);
  });

  it('never rehydrates a Private-availability version, even when asked for it by id', async () => {
    const res = await invoke({ modelVersionIds: `${MINE_PRIVATE_V},${MINE_PUBLIC_A}` });
    expect(res.statusCode).toBe(200);
    expect(versionIds(res.body, MINE_MODEL)).toEqual([MINE_PUBLIC_A]);
  });

  it('a request for a Private version alone returns no model at all', async () => {
    const res = await invoke({ modelVersionIds: String(MINE_PRIVATE_V) });
    expect(res.statusCode).toBe(200);
    expect(itemIds(res.body)).not.toContain(MINE_MODEL);
  });

  it('never rehydrates an unpublished version, even when asked for it by id', async () => {
    const res = await invoke({ modelVersionIds: `${MINE_DRAFT_V},${MINE_PUBLIC_A}` });
    expect(versionIds(res.body, MINE_MODEL)).toEqual([MINE_PUBLIC_A]);
  });

  it("composes with owner=mine: another owner's version is not returned", async () => {
    const res = await invoke({
      owner: 'mine',
      modelVersionIds: `${MINE_PUBLIC_A},${THEIRS_PUBLIC_V}`,
    });
    expect(itemIds(res.body)).toEqual([MINE_MODEL]);
    expect(versionIds(res.body, MINE_MODEL)).toEqual([MINE_PUBLIC_A]);
  });
});

describe('/api/v1/blocks/tools search_models — through the real search chain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primeIo();
    claimsBox.claims = claimsFor(`user:${OWNER_ID}`);
  });

  // A text query hands getModelsRaw an id list, which turns its own private-version filter off;
  // the tool shows only the latest version's base model, so a leaked Private version shows up as
  // that version's base model.
  it('a text query never surfaces a Private-availability version as the latest', async () => {
    const res = await invokeSearchTool({ query: 'anything' });
    expect(res.statusCode).toBe(200);
    const items: { id: number; baseModel?: string }[] = res.body.result.items;
    const mine = items.find((i) => i.id === MINE_MODEL);
    expect(mine, JSON.stringify(res.body)).toBeDefined();
    expect(mine!.baseModel).toBe(PUBLIC_BASE);
  });
});

describe('resolveModelSearchIds ownerUserId guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    primeIo();
  });

  // The id is interpolated into the Meili filter string, so anything but an integer is refused
  // before the search is sent.
  it('refuses a non-integer owner id without searching', async () => {
    for (const bad of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        resolveModelSearchIds({ query: 'x', limit: 10, browsingLevel: 1, ownerUserId: bad })
      ).rejects.toThrow('ownerUserId must be an integer');
    }
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('CONTROL: an integer owner id is searched with', async () => {
    await resolveModelSearchIds({ query: 'x', limit: 10, browsingLevel: 1, ownerUserId: OWNER_ID });
    expect(meiliFilter()).toContain(`user.id = ${OWNER_ID}`);
  });
});
