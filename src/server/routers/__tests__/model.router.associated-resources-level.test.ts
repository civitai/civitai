import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import { NsfwLevel, OnboardingSteps } from '~/server/common/enums';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const { getModelPoiAndOwner } = vi.hoisted(() => ({
  getModelPoiAndOwner: vi.fn(async () => ({ poi: false, userId: 1 })),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => ({
  ...(await importOriginal<typeof HotReads6>()),
  getModelPoiAndOwner,
}));

import { modelRouter } from '~/server/routers/model.router';

const ITEM_OWNER = 20;
const PG_MODEL = 11;
const X_MODEL = 12;
const PRIVATE_MODEL = 13;
const MINOR_MODEL = 14;
const TAGGED_MODEL = 15;
const SITE_EXCLUDED_TAG = 100;
const MATURE_EXCLUDED_TAG = 101;
const VIEWER_HIDDEN_TAG = 102;
const HIDDEN_USER = 30;
const linkedModel = (id: number, nsfwLevel: number, availability = 'Public', minor = false) => ({
  id,
  toArticle: null,
  toModel: {
    id,
    name: `model ${id}`,
    type: 'LORA',
    nsfwLevel,
    user: { id: ITEM_OWNER, username: 'item-owner' },
    userId: ITEM_OWNER,
    status: 'Published',
    availability,
    mode: null,
    poi: false,
    minor,
    sfwName: null,
    tagsOnModels: [] as { tagId: number }[],
  },
});
const taggedModel = (tagId: number, id = TAGGED_MODEL) => {
  const linked = linkedModel(id, NsfwLevel.PG);
  linked.toModel.tagsOnModels = [{ tagId }];
  return linked;
};

const PG_ARTICLE = 31;
const X_ARTICLE = 32;
const linkedArticle = (id: number, nsfwLevel: number, extra: Record<string, unknown> = {}) => ({
  id,
  toModel: null,
  toArticle: {
    id,
    title: `article ${id}`,
    nsfwLevel,
    user: { id: ITEM_OWNER, username: 'item-owner' },
    userId: ITEM_OWNER,
    publishedAt: new Date('2026-01-01'),
    status: 'Published',
    ingestion: 'Scanned',
    availability: 'Public',
    ...extra,
  },
});

const signedIn = (id: number) => ({
  id,
  onboarding: OnboardingSteps.Buzz,
  emailVerified: new Date(),
});
const scopedKey = { apiKeyId: 3, apiKeyType: 'User', subject: { type: 'apiKey', id: 3 } };

function caller(
  user: { id: number } | undefined,
  canViewNsfw: boolean,
  credential: Record<string, unknown> = {}
) {
  return modelRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {}, cookies: {} },
    res: { setHeader: () => undefined, removeHeader: () => undefined },
    cache: { edgeTTL: user ? 0 : 60 },
    features: { canViewNsfw },
    track: {},
    ...credential,
  } as never);
}

function listedIds(
  user: { id: number } | undefined,
  canViewNsfw: boolean,
  credential?: Record<string, unknown>
) {
  return caller(user, canViewNsfw, credential)
    .getAssociatedResourcesSimple({
      fromId: 1,
      type: 'Suggested',
      browsingLevel: allBrowsingLevelsFlag,
    })
    .then((items) => items.map(({ item }) => item.id));
}

// The site's addon rules turn minor content off and exclude one tag at every level, and exclude
// another tag only where mature levels are browsed. Read once per process (memoised), so they hold
// for the whole file.
beforeAll(() => {
  redisMock.sysRedis.get.mockResolvedValue(
    JSON.stringify([
      { type: 'none', nsfwLevels: [], disableMinor: true, excludedTagIds: [SITE_EXCLUDED_TAG] },
      { type: 'some', nsfwLevels: [NsfwLevel.X], excludedTagIds: [MATURE_EXCLUDED_TAG] },
    ]) as never
  );
});

// The viewer's hidden preferences, as the per-user cache hash holds them.
function hide({
  tags = [],
  users = [],
  models = [],
}: Partial<Record<'tags' | 'users' | 'models', number[]>> = {}) {
  redisMock.redis.packed.hGetAll.mockResolvedValue({
    'hidden-tags-4': tags.map((id) => ({ id, name: `tag ${id}` })),
    'hidden-users-5': users.map((id) => ({ id, username: `user ${id}` })),
    'hidden-models-3': models,
    'hidden-images-3': [],
    'hidden-images-implicit': [],
    'hidden-model3ds-1': [],
    'blocked-users-2': [],
    'blocked-by-users-2': [],
  } as never);
}

// Users who blocked the caller, as the per-user cache hash holds them.
function blockedBy(ids: number[]) {
  redisMock.redis.packed.hGet.mockImplementation((async (_key: string, field: string) =>
    field === 'blocked-by-users-2'
      ? ids.map((id) => ({ id, username: `user ${id}` }))
      : null) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.redis.packed.get.mockResolvedValue([] as never);
  redisMock.redis.packed.hGet.mockResolvedValue(null as never);
  hide();
  dbMock.dbWrite.modelAssociations.findMany.mockResolvedValue([
    linkedModel(PG_MODEL, NsfwLevel.PG),
    linkedModel(X_MODEL, NsfwLevel.X),
    linkedModel(PRIVATE_MODEL, NsfwLevel.PG, 'Private'),
  ] as never);
});

// Visibility rule for linked models set in civitai/civitai#10680.
describe('model.getAssociatedResourcesSimple browsing level', () => {
  // Signed-out answers are edge-cached by URL, so the result cannot vary with the requested level.
  it('a signed-out request asking for every level gets PG only', async () => {
    expect(await listedIds(undefined, true)).toEqual([PG_MODEL]);
  });

  it('a signed-out request asking for every level gets no mature article', async () => {
    dbMock.dbWrite.modelAssociations.findMany.mockResolvedValue([
      linkedArticle(PG_ARTICLE, NsfwLevel.PG),
      linkedArticle(X_ARTICLE, NsfwLevel.X),
    ] as never);
    expect(await listedIds(undefined, true)).toEqual([PG_ARTICLE]);
  });

  it('a signed-in request on the SFW domain gets no mature model', async () => {
    expect(await listedIds({ id: 5 }, false)).toEqual([PG_MODEL]);
  });

  it('a signed-in request on the mature domain gets the level it asked for', async () => {
    expect(await listedIds({ id: 5 }, true)).toEqual([PG_MODEL, X_MODEL]);
  });
});

describe('model.getAssociatedResourcesSimple owner view', () => {
  it('shows the owner their own private model on a session, not on a scoped key', async () => {
    expect(await listedIds(signedIn(ITEM_OWNER), true)).toContain(PRIVATE_MODEL);
    expect(
      await listedIds(signedIn(ITEM_OWNER), true, {
        ...scopedKey,
        tokenScope: TokenScope.ModelsRead,
      })
    ).not.toContain(PRIVATE_MODEL);
  });
});

// Linked articles take the same owner-or-moderator viewer as linked models.
describe('model.getAssociatedResourcesSimple article owner view', () => {
  const DRAFT_ARTICLE = 33;
  const UNRATED_ARTICLE = 34;
  beforeEach(() => {
    dbMock.dbWrite.modelAssociations.findMany.mockResolvedValue([
      linkedArticle(PG_ARTICLE, NsfwLevel.PG),
      linkedArticle(DRAFT_ARTICLE, NsfwLevel.PG, { status: 'Draft', publishedAt: null }),
      linkedArticle(UNRATED_ARTICLE, 0),
    ] as never);
  });

  it('shows the author their own draft and unrated articles on a session, not on a scoped key', async () => {
    expect(await listedIds(signedIn(ITEM_OWNER), true)).toEqual([
      PG_ARTICLE,
      DRAFT_ARTICLE,
      UNRATED_ARTICLE,
    ]);
    expect(
      await listedIds(signedIn(ITEM_OWNER), true, {
        ...scopedKey,
        tokenScope: TokenScope.ModelsRead,
      })
    ).toEqual([PG_ARTICLE]);
  });
});

describe('model.getAssociatedResourcesSimple blocked authors', () => {
  it('hides an article whose author blocked the caller, on a session and on a scoped key', async () => {
    dbMock.dbWrite.modelAssociations.findMany.mockResolvedValue([
      linkedArticle(PG_ARTICLE, NsfwLevel.PG),
    ] as never);
    blockedBy([ITEM_OWNER]);
    expect(await listedIds(signedIn(5), true)).toEqual([]);
    expect(
      await listedIds(signedIn(5), true, { ...scopedKey, tokenScope: TokenScope.ModelsRead })
    ).toEqual([]);
  });
});

describe('model.getAssociatedResourcesSimple minor content', () => {
  const minorIds = (user: { id: number; isModerator?: boolean }) => {
    dbMock.dbWrite.modelAssociations.findMany.mockResolvedValue([
      linkedModel(PG_MODEL, NsfwLevel.PG),
      linkedModel(MINOR_MODEL, NsfwLevel.PG, 'Public', true),
    ] as never);
    return listedIds(user, true);
  };

  it('with minor content off by the site rules, hides a minor-flagged model', async () => {
    expect(await minorIds(signedIn(5))).toEqual([PG_MODEL]);
  });

  it('shows it to its owner and to moderators', async () => {
    expect(await minorIds(signedIn(ITEM_OWNER))).toContain(MINOR_MODEL);
    expect(await minorIds({ ...signedIn(9), isModerator: true })).toContain(MINOR_MODEL);
  });
});

describe('model.getAssociatedResourcesSimple excluded tags and hidden preferences', () => {
  const ids = (
    linked: ReturnType<typeof linkedModel>[],
    user: { id: number; isModerator?: boolean } | undefined,
    canViewNsfw = true
  ) => {
    dbMock.dbWrite.modelAssociations.findMany.mockResolvedValue([
      linkedModel(PG_MODEL, NsfwLevel.PG),
      ...linked,
    ] as never);
    return listedIds(user, canViewNsfw);
  };

  it('hides a model carrying a tag the site rules exclude, from signed-out and signed-in alike', async () => {
    expect(await ids([taggedModel(SITE_EXCLUDED_TAG)], undefined)).toEqual([PG_MODEL]);
    expect(await ids([taggedModel(SITE_EXCLUDED_TAG)], signedIn(5))).toEqual([PG_MODEL]);
  });

  it('applies a tag excluded only at mature levels where mature levels are servable', async () => {
    expect(await ids([taggedModel(MATURE_EXCLUDED_TAG)], signedIn(5), false)).toEqual([
      PG_MODEL,
      TAGGED_MODEL,
    ]);
    expect(await ids([taggedModel(MATURE_EXCLUDED_TAG)], signedIn(5), true)).toEqual([PG_MODEL]);
  });

  it('shows a model with an excluded tag to its owner, and to moderators for the site rules', async () => {
    expect(await ids([taggedModel(SITE_EXCLUDED_TAG)], signedIn(ITEM_OWNER))).toContain(
      TAGGED_MODEL
    );
    expect(
      await ids([taggedModel(SITE_EXCLUDED_TAG)], { ...signedIn(9), isModerator: true })
    ).toContain(TAGGED_MODEL);
  });

  it("hides a model carrying one of the viewer's hidden tags, unless the cookie turns hiding off", async () => {
    hide({ tags: [VIEWER_HIDDEN_TAG] });
    expect(await ids([taggedModel(VIEWER_HIDDEN_TAG)], signedIn(5))).toEqual([PG_MODEL]);
    expect(
      await listedIds(signedIn(5), true, {
        req: { headers: {}, cookies: { disableHidden: 'true' } },
      })
    ).toEqual([PG_MODEL, TAGGED_MODEL]);
  });

  it('hides a model by a user the viewer hid', async () => {
    hide({ users: [HIDDEN_USER] });
    const byHiddenUser = linkedModel(TAGGED_MODEL, NsfwLevel.PG);
    byHiddenUser.toModel.userId = HIDDEN_USER;
    expect(await ids([byHiddenUser], signedIn(5))).toEqual([PG_MODEL]);
  });

  it('hides a model the viewer hid', async () => {
    hide({ models: [X_MODEL] });
    expect(await ids([linkedModel(X_MODEL, NsfwLevel.X)], signedIn(5))).toEqual([PG_MODEL]);
  });
});

describe('model.setAssociatedResources', () => {
  const FROM_OWNER = 5;
  const removedIds = async (
    canViewNsfw: boolean,
    linked: ReturnType<typeof linkedModel> | ReturnType<typeof linkedArticle> = linkedModel(
      X_MODEL,
      NsfwLevel.X
    ),
    credential?: Record<string, unknown>
  ) => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      userId: FROM_OWNER,
      associations: [{ ...linked, id: 1, toModelId: linked.toModel?.id ?? null }],
    } as never);
    dbMock.dbWrite.$transaction.mockResolvedValue([] as never);
    await caller(signedIn(FROM_OWNER), canViewNsfw, credential).setAssociatedResources({
      fromId: 1,
      type: 'Suggested',
      associations: [],
    });
    const [args] = dbMock.dbWrite.modelAssociations.deleteMany.mock.calls[0] as [
      { where: { id: { in: number[] } } }
    ];
    return args.where.id.in;
  };
  it('a save on the SFW domain keeps a mature link its editor could not show', async () => {
    expect(await removedIds(false)).toEqual([]);
  });

  it('a save on the mature domain removes a mature link its editor showed', async () => {
    expect(await removedIds(true)).toEqual([1]);
  });

  it('with minor content off by the site rules, a save keeps a minor-flagged link', async () => {
    expect(await removedIds(true, linkedModel(MINOR_MODEL, NsfwLevel.PG, 'Public', true))).toEqual(
      []
    );
  });

  it('a save keeps links hidden by an excluded tag or a hidden model', async () => {
    expect(await removedIds(true, taggedModel(SITE_EXCLUDED_TAG))).toEqual([]);
    vi.clearAllMocks();
    redisMock.redis.packed.get.mockResolvedValue([] as never);
    hide({ models: [PG_MODEL] });
    expect(await removedIds(true, linkedModel(PG_MODEL, NsfwLevel.PG))).toEqual([]);
  });

  it('a save on a scoped key keeps a link to an article whose author blocked the caller', async () => {
    blockedBy([ITEM_OWNER]);
    const scopedWrite = { ...scopedKey, tokenScope: TokenScope.ModelsWrite };
    expect(await removedIds(true, linkedArticle(PG_ARTICLE, NsfwLevel.PG), scopedWrite)).toEqual(
      []
    );
  });

  it("a save on a scoped key keeps a link to the caller's own draft article", async () => {
    const ownDraft = linkedArticle(40, NsfwLevel.PG, {
      userId: FROM_OWNER,
      status: 'Draft',
      publishedAt: null,
    });
    expect(await removedIds(true, ownDraft)).toEqual([1]);
    vi.clearAllMocks();
    expect(
      await removedIds(true, ownDraft, { ...scopedKey, tokenScope: TokenScope.ModelsWrite })
    ).toEqual([]);
  });

  it("a save on a scoped key keeps a link to the caller's own private model", async () => {
    const ownPrivate = linkedModel(PRIVATE_MODEL, NsfwLevel.PG, 'Private');
    ownPrivate.toModel.userId = FROM_OWNER;
    expect(await removedIds(true, ownPrivate)).toEqual([1]);
    vi.clearAllMocks();
    expect(
      await removedIds(true, ownPrivate, { ...scopedKey, tokenScope: TokenScope.ModelsWrite })
    ).toEqual([]);
  });
});
