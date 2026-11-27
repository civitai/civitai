import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import { NsfwLevel } from '~/server/common/enums';
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

const PG_MODEL = 11;
const X_MODEL = 12;
const linkedModel = (id: number, nsfwLevel: number) => ({
  id,
  toArticle: null,
  toModel: {
    id,
    name: `model ${id}`,
    type: 'LORA',
    nsfwLevel,
    user: { id: 20, username: 'item-owner' },
    userId: 20,
    status: 'Published',
    availability: 'Public',
    mode: null,
    poi: false,
    sfwName: null,
  },
});

/**
 * A signed-out answer is edge-cached by URL, so it must hold only what every signed-out visitor
 * may see, whatever level the URL asks for.
 */
function listedIds(user: { id: number } | undefined, canViewNsfw: boolean) {
  return modelRouter
    .createCaller({
      user,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      req: { headers: {} },
      res: { setHeader: () => undefined, removeHeader: () => undefined },
      cache: { edgeTTL: user ? 0 : 60 },
      features: { canViewNsfw },
      track: {},
    } as never)
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
