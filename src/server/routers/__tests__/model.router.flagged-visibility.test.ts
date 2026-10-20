import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelController from '~/server/controllers/model.controller';
import type * as ModelService from '~/server/services/model.service';
import type * as SystemCache from '~/server/services/system-cache';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const handlers = vi.hoisted(() => ({
  getModelOwnerHandler: vi.fn(async () => 'owner'),
  getModelVersionsHandler: vi.fn(async () => 'versions'),
  getModelDetailsForReviewHandler: vi.fn(async () => 'details'),
  getAssociatedResourcesCardDataHandler: vi.fn(async () => 'cards'),
  getSimpleModelWithVersions: vi.fn(async () => 'simple'),
  getAssociatedResourcesSimple: vi.fn(async () => 'associated'),
}));

vi.mock('~/server/controllers/model.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelController>()),
  getModelOwnerHandler: handlers.getModelOwnerHandler,
  getModelVersionsHandler: handlers.getModelVersionsHandler,
  getModelDetailsForReviewHandler: handlers.getModelDetailsForReviewHandler,
  getAssociatedResourcesCardDataHandler: handlers.getAssociatedResourcesCardDataHandler,
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: async () => [],
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelService>()),
  getSimpleModelWithVersions: handlers.getSimpleModelWithVersions,
  getAssociatedResourcesSimple: handlers.getAssociatedResourcesSimple,
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
  dbMock.dbRead.model.findUnique.mockResolvedValue({ poi, userId: OWNER });
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
