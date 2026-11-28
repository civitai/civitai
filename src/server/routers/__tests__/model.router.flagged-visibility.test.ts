import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type * as ModelController from '~/server/controllers/model.controller';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Read when region-blocking loads: requests from XX are restricted.
vi.hoisted(() => {
  process.env.REGION_RESTRICTION_CONFIG = 'XX:2020-01-01';
});

const handlers = vi.hoisted(() => ({
  getModelOwnerHandler: vi.fn(async () => 'owner'),
  getModelVersionsHandler: vi.fn(async () => 'versions'),
  getModelDetailsForReviewHandler: vi.fn(async () => 'details'),
  getAssociatedResourcesCardDataHandler: vi.fn(async () => 'cards'),
  getSimpleModelWithVersions: vi.fn(async () => 'simple'),
  setAssociatedResources: vi.fn(async (..._args: unknown[]) => ({})),
  getAssociatedResourcesSimple: vi.fn(
    async (..._args: unknown[]) =>
      ({ items: [], regionDependent: false } as { items: unknown[]; regionDependent: boolean })
  ),
}));

vi.mock('~/server/controllers/model.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelController>()),
  getModelOwnerHandler: handlers.getModelOwnerHandler,
  getModelVersionsHandler: handlers.getModelVersionsHandler,
  getModelDetailsForReviewHandler: handlers.getModelDetailsForReviewHandler,
  getAssociatedResourcesCardDataHandler: handlers.getAssociatedResourcesCardDataHandler,
}));
// The visibility middleware's POI/owner read is a Kysely statement (its row, against a real
// database, is pinned in hot-reads-6.kysely-parity.test.ts).
const { getModelPoiAndOwner } = vi.hoisted(() => ({ getModelPoiAndOwner: vi.fn() }));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getModelPoiAndOwner,
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: async () => [],
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getSimpleModelWithVersions: handlers.getSimpleModelWithVersions,
  getAssociatedResourcesSimple: handlers.getAssociatedResourcesSimple,
  setAssociatedResources: handlers.setAssociatedResources,
}));

import { modelRouter } from '~/server/routers/model.router';

/**
 * Lookups by model id on the model router answer NOT_FOUND for a model flagged `poi` unless the
 * caller is its owner or a moderator. Each handler is replaced by a sentinel, so "served" means
 * the request got past the router to the handler.
 */

const OWNER = 7;
const VIEWERS = {
  anon: undefined,
  other: { id: 8, isModerator: false },
  owner: { id: OWNER, isModerator: false },
  moderator: { id: 1, isModerator: true },
} as const;
type ViewerKey = keyof typeof VIEWERS;

function caller(viewer: ViewerKey) {
  const user = VIEWERS[viewer];
  return modelRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined, removeHeader: () => undefined },
    cache: { edgeTTL: user ? 0 : 60 },
    features: {},
    track: {},
  } as never);
}

const LOOKUPS = {
  getOwner: (c: ReturnType<typeof caller>) => c.getOwner({ id: 1 }),
  getVersions: (c: ReturnType<typeof caller>) => c.getVersions({ id: 1 }),
  getModelDetailsForReview: (c: ReturnType<typeof caller>) => c.getModelDetailsForReview({ id: 1 }),
  getSimple: (c: ReturnType<typeof caller>) => c.getSimple({ id: 1 }),
  getAssociatedResourcesCardData: (c: ReturnType<typeof caller>) =>
    c.getAssociatedResourcesCardData({ fromId: 1, type: 'Suggested' }),
  getAssociatedResourcesSimple: (c: ReturnType<typeof caller>) =>
    c.getAssociatedResourcesSimple({ fromId: 1, type: 'Suggested' }),
};
type LookupKey = keyof typeof LOOKUPS;

async function outcome(lookup: LookupKey, viewer: ViewerKey, poi: boolean) {
  getModelPoiAndOwner.mockResolvedValue({ poi, userId: OWNER });
  return LOOKUPS[lookup](caller(viewer)).then(
    () => 'served',
    (e: { code?: string }) => {
      if (e?.code === 'NOT_FOUND') return 'not-found';
      throw e;
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each(Object.keys(LOOKUPS) as LookupKey[])('model.%s', (lookup) => {
  it.each<[ViewerKey, string]>([
    ['anon', 'not-found'],
    ['other', 'not-found'],
    ['owner', 'served'],
    ['moderator', 'served'],
  ])('flagged model: %s gets %s', async (viewer, expected) => {
    expect(await outcome(lookup, viewer, true)).toBe(expected);
  });

  it('control: an unflagged model is served to anyone', async () => {
    expect(await outcome(lookup, 'anon', false)).toBe('served');
    expect(await outcome(lookup, 'other', false)).toBe('served');
  });
});

describe('model.getWithCategoriesSimple', () => {
  async function whereFor(viewer: ViewerKey) {
    dbMock.dbRead.model.findMany.mockResolvedValue([]);
    dbMock.dbRead.model.count.mockResolvedValue(0);
    await caller(viewer).getWithCategoriesSimple({ userId: OWNER, limit: 10, page: 1 });
    return dbMock.dbRead.model.findMany.mock.calls.at(-1)?.[0].where;
  }

  it.each<[ViewerKey, unknown]>([
    ['anon', [{ poi: false }]],
    ['other', [{ poi: false }, { userId: 8 }]],
    ['owner', [{ poi: false }, { userId: OWNER }]],
  ])('lists flagged models to %s only when they own them', async (viewer, or) => {
    expect((await whereFor(viewer)).OR).toEqual(or);
  });

  it('moderators get the unfiltered list', async () => {
    expect((await whereFor('moderator')).OR).toBeUndefined();
  });
});

describe('model.getAssociatedResourcesSimple and region', () => {
  const ctxFor = (
    user: (typeof VIEWERS)[ViewerKey],
    credential: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) => ({
    user,
    acceptableOrigin: true,
    ...credential,
    req: { headers },
    res: { setHeader: () => undefined, removeHeader: () => undefined },
    cache: { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30, canCache: true, skip: false },
    features: {},
    track: {},
  });
  const session = { tokenScope: TokenScope.Full, apiKeyId: null };

  async function run(regionDependent: boolean, ctx: ReturnType<typeof ctxFor>) {
    getModelPoiAndOwner.mockResolvedValue({ poi: false, userId: OWNER });
    handlers.getAssociatedResourcesSimple.mockResolvedValueOnce({ items: [], regionDependent });
    await modelRouter
      .createCaller(ctx as never)
      .getAssociatedResourcesSimple({ fromId: 1, type: 'Suggested' });
    return handlers.getAssociatedResourcesSimple.mock.calls.at(-1)?.[1] as {
      viewer: { isModerator?: boolean };
      isRestricted: () => boolean;
    };
  }

  it('keeps a region-dependent answer out of the edge and browser caches', async () => {
    const ctx = ctxFor(VIEWERS.anon, session);
    await run(true, ctx);
    expect(ctx.cache).toMatchObject({ edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0 });
  });

  it('leaves the cache alone otherwise', async () => {
    const ctx = ctxFor(VIEWERS.anon, session);
    await run(false, ctx);
    expect(ctx.cache).toMatchObject({ edgeTTL: 60, browserTTL: 60 });
  });

  it('exempts a moderator from the region only on a session or full-access key', async () => {
    expect((await run(false, ctxFor(VIEWERS.moderator, session))).viewer.isModerator).toBe(true);
    const scopedKey = {
      tokenScope: TokenScope.ModelsRead,
      apiKeyId: 5,
      apiKeyType: 'User',
      subject: { type: 'apiKey', id: 5 },
    };
    expect((await run(false, ctxFor(VIEWERS.moderator, scopedKey))).viewer.isModerator).toBe(false);
  });

  it('reads the region from the request, for the list and for a save', async () => {
    const XX = { 'cf-ipcountry': 'XX' };
    const editor = { ...VIEWERS.owner, onboarding: 0xffff };
    expect((await run(false, ctxFor(VIEWERS.anon, session, XX))).isRestricted()).toBe(true);
    expect((await run(false, ctxFor(VIEWERS.anon, session))).isRestricted()).toBe(false);

    await modelRouter
      .createCaller({ ...ctxFor(VIEWERS.owner, session, XX), user: editor } as never)
      .setAssociatedResources({ fromId: 1, type: 'Suggested', associations: [] });
    const reader = handlers.setAssociatedResources.mock.calls.at(-1)?.[2] as {
      isRestricted: () => boolean;
    };
    expect(reader.isRestricted()).toBe(true);
  });

  it('does not count a moderator on a scoped key as a moderator for a save', async () => {
    const moderator = { ...VIEWERS.moderator, onboarding: 0xffff };
    const scopedKey = {
      tokenScope: TokenScope.ModelsWrite,
      apiKeyId: 5,
      apiKeyType: 'User',
      subject: { type: 'apiKey', id: 5 },
    };
    await modelRouter
      .createCaller({ ...ctxFor(VIEWERS.moderator, scopedKey), user: moderator } as never)
      .setAssociatedResources({ fromId: 1, type: 'Suggested', associations: [] });
    const reader = handlers.setAssociatedResources.mock.calls.at(-1)?.[2] as {
      viewer: { isModerator?: boolean };
    };
    expect(reader.viewer.isModerator).toBe(false);
  });
});
