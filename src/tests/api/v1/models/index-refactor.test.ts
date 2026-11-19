import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { constants } from '~/server/common/constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

import {
  publicBrowsingLevelsFlag,
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * Behavior-preservation tests for the /api/v1/models refactor that extracted
 * the search + shaping body into runModelSearch. The public endpoint had NO
 * test before this change; these lock in its MATURITY contract so the refactor
 * (and the shared helper the block endpoint now also uses) cannot silently
 * change the public endpoint:
 *
 *   - nsfw off  → publicBrowsingLevelsFlag, nsfwImagePassthrough false
 *   - nsfw on   → allBrowsingLevelsFlag,    nsfwImagePassthrough true
 *   - restricted region → sfwBrowsingLevelsFlag (override), regardless of nsfw
 *
 * The model service + Meili are mocked so no Prisma/Meili is loaded.
 */

const { mockRunModelSearch, mockResolveModelSearchIds, mockIsRegionRestricted, mockGetRegion } =
  vi.hoisted(() => ({
    mockRunModelSearch: vi.fn(),
    mockResolveModelSearchIds: vi.fn(),
    mockIsRegionRestricted: vi.fn(),
    mockGetRegion: vi.fn(),
  }));

vi.mock('~/server/services/model-search.service', () => ({
  runModelSearch: mockRunModelSearch,
  resolveModelSearchIds: mockResolveModelSearchIds,
  ModelSearchMeiliTimeoutError: class extends Error {},
}));

vi.mock('~/server/utils/region-blocking', () => ({
  getRegion: mockGetRegion,
  isRegionRestricted: mockIsRegionRestricted,
}));

vi.mock('~/server/utils/server-domain', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isRedCapableHost: (host?: string | null) => host === 'civitai.red',
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  // Passthrough: invoke handler as the request's `testUser` (anonymous when unset).
  MixedAuthEndpoint: (handler: any) => (req: any, res: any) => handler(req, res, req.testUser),
  handleEndpointError: (res: any, e: any) => res.status(500).json({ error: String(e) }),
}));

vi.mock('~/server/utils/pagination-helpers', () => ({
  getNextPage: () => ({ baseUrl: { origin: 'https://civitai.com' }, nextPage: undefined }),
  getPagination: () => ({ skip: 0 }),
}));

vi.mock('~/server/services/user.service', () => ({
  getUserBookmarkCollections: vi.fn().mockResolvedValue([]),
}));

function fakeRes() {
  const res: any = {
    headers: {},
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
  return res as NextApiResponse & { statusCode?: number; body?: any; headers: Record<string, any> };
}

// The handler module (`~/pages/api/v1/models/index`) cold-transforms a sizable
// graph (~9s in isolation); a PER-TEST `await import(...)` of it races the suite's
// worker pool for CPU and blew the 10s default timeout under full-suite contention
// (cascading the next test into a half-loaded-module assertion). Import it ONCE here
// with a generous import-only timeout; the per-test `invoke` then just calls the
// already-loaded handler. The mocked deps make this a pure in-memory call.
let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void> | void;

beforeAll(async () => {
  const mod = await import('~/pages/api/v1/models/index');
  handler = mod.default as any;
}, 120000);

async function invoke(query: Record<string, unknown>, host = 'civitai.com') {
  const req = {
    method: 'GET',
    query,
    headers: { host },
    url: '/api/v1/models',
  } as unknown as NextApiRequest;
  const res = fakeRes();
  await handler(req, res);
  return res;
}

describe('/api/v1/models refactor — public maturity contract preserved', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
    mockGetRegion.mockReturnValue('US');
    mockIsRegionRestricted.mockReturnValue(false);
  });

  it('nsfw off → publicBrowsingLevelsFlag + nsfwImagePassthrough false', async () => {
    const res = await invoke({});
    expect(res.statusCode).toBe(200);
    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(publicBrowsingLevelsFlag);
    expect(ctx.nsfwImagePassthrough).toBe(false);
  });

  it('tells the search whether the host is red-capable, which decides the datasets it lists', async () => {
    await invoke({}, 'civitai.com');
    await invoke({}, 'civitai.red');
    expect(mockRunModelSearch.mock.calls.map(([, ctx]) => ctx.redCapable)).toEqual([false, true]);
  });

  it('nsfw=true → allBrowsingLevelsFlag + nsfwImagePassthrough true (legacy widening kept)', async () => {
    const res = await invoke({ nsfw: 'true' });
    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(allBrowsingLevelsFlag);
    expect(ctx.nsfwImagePassthrough).toBe(true);
  });

  it('restricted region → sfwBrowsingLevelsFlag override even with nsfw=true', async () => {
    mockIsRegionRestricted.mockReturnValue(true);
    const res = await invoke({ nsfw: 'true' });
    const [, ctx] = mockRunModelSearch.mock.calls[0];
    expect(ctx.browsingLevel).toBe(sfwBrowsingLevelsFlag);
    // Images are held to that level too: the nsfw widening does not apply there.
    expect(ctx.nsfwImagePassthrough).toBe(false);
  });

  it('keeps an nsfw=true answer out of the shared cache, in every region', async () => {
    for (const restricted of [true, false]) {
      mockIsRegionRestricted.mockReturnValue(restricted);
      const res = await invoke({ nsfw: 'true' });
      expect(res.headers['Cache-Control']).toBe('private, no-store');
    }
  });

  it('leaves the default answer to the shared cache (control)', async () => {
    for (const restricted of [true, false]) {
      mockIsRegionRestricted.mockReturnValue(restricted);
      const res = await invoke({});
      expect(res.headers['Cache-Control']).toBeUndefined();
    }
  });

  it('query path uses the same browsingLevel for the Meili pre-step', async () => {
    await invoke({ query: 'foo', nsfw: 'true' });
    expect(mockResolveModelSearchIds).toHaveBeenCalledTimes(1);
    expect(mockResolveModelSearchIds.mock.calls[0][0].browsingLevel).toBe(allBrowsingLevelsFlag);
  });

  it('query path forwards the types filter to the Meili pre-step', async () => {
    await invoke({ query: 'fantasy', types: 'Wildcards' });
    expect(mockResolveModelSearchIds.mock.calls[0][0].types).toEqual(['Wildcards']);
  });

  it('query path forwards baseModels and supportsGeneration to the Meili pre-step', async () => {
    await invoke({ query: 'fantasy', baseModels: 'SD 3.5 Large', supportsGeneration: 'true' });
    expect(mockResolveModelSearchIds.mock.calls[0][0].baseModels).toEqual(['SD 3.5 Large']);
    expect(mockResolveModelSearchIds.mock.calls[0][0].supportsGeneration).toBe(true);
  });

  it('401s on favorites/hidden without a user (authed-only options gate preserved)', async () => {
    const res = await invoke({ favorites: 'true' });
    expect(res.statusCode).toBe(401);
    expect(mockRunModelSearch).not.toHaveBeenCalled();
  });
});

describe('/api/v1/models — an explicit sort reaches the Meili pre-step, the schema default does not', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockResolveModelSearchIds.mockResolvedValue({ searchIds: [], nextCursor: undefined });
    mockGetRegion.mockReturnValue('US');
    mockIsRegionRestricted.mockReturnValue(false);
  });

  it('?query=&sort= forwards the named sort', async () => {
    await invoke({ query: 'anime', sort: 'Most Downloaded' });
    expect(mockResolveModelSearchIds.mock.calls[0][0].sort).toBe('Most Downloaded');
  });

  it('?query= alone forwards no sort, even though the parsed input carries the default', async () => {
    await invoke({ query: 'anime' });
    expect(mockResolveModelSearchIds.mock.calls[0][0].sort).toBeUndefined();
    const [input] = mockRunModelSearch.mock.calls[0];
    expect(input.sort).toBe('Highest Rated');
  });
});

describe('/api/v1/models moderator view follows the credential', () => {
  const moderator = { id: 5, isModerator: true };
  const personalKey = (tokenScope: bigint) => ({
    tokenScope,
    apiKeyId: 9,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 9 },
  });
  const FULL = TokenScope.Full;
  const MODELS_READ = TokenScope.ModelsRead;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunModelSearch.mockResolvedValue({ items: [], nextCursor: undefined });
    mockGetRegion.mockReturnValue('US');
    mockIsRegionRestricted.mockReturnValue(false);
  });

  async function searchedAs(context: object | undefined, query: Record<string, string> = {}) {
    const req = {
      method: 'GET',
      query,
      headers: { host: 'civitai.com' },
      url: '/api/v1/models',
      testUser: moderator,
      context,
    } as unknown as NextApiRequest;
    const res = fakeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    return mockRunModelSearch.mock.calls[0][1].user;
  }

  it.each([
    ['a session', undefined],
    ['a full-scope personal key', personalKey(FULL)],
  ])('keeps the moderator view on %s', async (_label, context) => {
    expect(await searchedAs(context)).toEqual(moderator);
  });

  it.each([
    ['a scoped personal key', personalKey(MODELS_READ)],
    [
      'an app token',
      { tokenScope: FULL, apiKeyId: 9, apiKeyType: 'Access', subject: { type: 'oauth', id: 'c' } },
    ],
  ])('searches as signed out on %s', async (_label, context) => {
    expect(await searchedAs(context)).toBeUndefined();
  });

  it('searches as signed out for a non-moderator on a scoped key too', async () => {
    const req = {
      method: 'GET',
      query: {},
      headers: { host: 'civitai.com' },
      url: '/api/v1/models',
      testUser: { id: 6, isModerator: false },
      context: personalKey(MODELS_READ),
    } as unknown as NextApiRequest;
    const res = fakeRes();
    await handler(req, res);
    expect(mockRunModelSearch.mock.calls[0][1].user).toBeUndefined();
  });

  it('keeps the system account as it is on its own key', async () => {
    const system = { id: constants.system.user.id, isModerator: true };
    const req = {
      method: 'GET',
      query: {},
      headers: { host: 'civitai.com' },
      url: '/api/v1/models',
      testUser: system,
      context: personalKey(MODELS_READ),
    } as unknown as NextApiRequest;
    const res = fakeRes();
    await handler(req, res);
    expect(mockRunModelSearch.mock.calls[0][1].user).toEqual(system);
  });

  it('searches as signed out for an own list filtered to Private models', async () => {
    expect(
      await searchedAs(personalKey(MODELS_READ), { hidden: 'true', availability: 'Private' })
    ).toBeUndefined();
  });

  it.each(['hidden', 'followed', 'favorites'])(
    "keeps the caller's id, without the moderator view, for their %s list",
    async (list) => {
      expect(await searchedAs(personalKey(MODELS_READ), { [list]: 'true' })).toEqual({
        ...moderator,
        isModerator: false,
      });
    }
  );
});
