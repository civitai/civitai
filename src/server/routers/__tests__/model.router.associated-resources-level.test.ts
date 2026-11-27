import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
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
const linkedModel = (id: number, nsfwLevel: number, availability = 'Public') => ({
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
    sfwName: null,
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
    req: { headers: {} },
    res: { setHeader: () => undefined, removeHeader: () => undefined },
    cache: { edgeTTL: user ? 0 : 60 },
    features: { canViewNsfw },
    track: {},
    ...credential,
  } as never);
}

/**
 * A signed-out answer is edge-cached by URL, so it must hold only what every signed-out visitor
 * may see, whatever level the URL asks for.
 */
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

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.modelAssociations.findMany.mockResolvedValue([
    linkedModel(PG_MODEL, NsfwLevel.PG),
    linkedModel(X_MODEL, NsfwLevel.X),
    linkedModel(PRIVATE_MODEL, NsfwLevel.PG, 'Private'),
  ] as never);
});

describe('model.getAssociatedResourcesSimple browsing level', () => {
  it('a signed-out request asking for every level gets PG only', async () => {
    expect(await listedIds(undefined, true)).toEqual([PG_MODEL]);
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

describe('model.setAssociatedResources', () => {
  const FROM_OWNER = 5;
  const removedIds = async (canViewNsfw: boolean) => {
    dbMock.dbWrite.model.findUnique.mockResolvedValue({
      userId: FROM_OWNER,
      associations: [{ ...linkedModel(X_MODEL, NsfwLevel.X), id: 1, toModelId: X_MODEL }],
    } as never);
    dbMock.dbWrite.$transaction.mockResolvedValue([] as never);
    await caller(signedIn(FROM_OWNER), canViewNsfw).setAssociatedResources({
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
});
