import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads6 from '@civitai/db-queries/hot-reads-6';
import type * as ModelController from '~/server/controllers/model.controller';
import type * as SystemCache from '~/server/services/system-cache';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// Any flag read on these paths answers false, without a Flipt client.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-6', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads6>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// The handler behind the middleware is a sentinel: "served" means the request got past it.
const { getModelOwnerHandler } = vi.hoisted(() => ({
  getModelOwnerHandler: vi.fn(async () => 'owner'),
}));
vi.mock('~/server/controllers/model.controller', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelController>()),
  getModelOwnerHandler,
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: async () => [],
}));

import * as queries from '@civitai/db-queries/hot-reads-6';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';
import { modelRouter } from '~/server/routers/model.router';

/**
 * The POI check of the `model.*` visibility middleware (`modelVisibleToViewer`): the Kysely read on
 * the replica, whose row alone decides (the Prisma stub, if it were read, would say the opposite).
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const OWNER = 9107;
const OTHER = { id: 9108, isModerator: false };

const getOwner = () =>
  modelRouter
    .createCaller({
      user: OTHER,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      req: { headers: {} },
      res: { setHeader: () => undefined, removeHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: {},
      track: {},
    } as never)
    .getOwner({ id: 9101 })
    .then(
      () => 'served',
      (e: { code?: string }) => {
        if (e?.code === 'NOT_FOUND') return 'not-found';
        throw e;
      }
    );

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockReset().mockResolvedValue(false);
  q.getModelPoiAndOwner.mockReset();
});

describe('modelVisibleToViewer', () => {
  it('the Kysely read on the replica decides a POI model is hidden', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({ poi: false, userId: OWNER });
    q.getModelPoiAndOwner.mockResolvedValue({ poi: true, userId: OWNER } as never);
    expect(await getOwner()).toBe('not-found');
    expect(q.getModelPoiAndOwner.mock.calls).toEqual([[kyselyRead, 9101]]);
    expect(q.getModelPoiAndOwner.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.model.findUnique).not.toHaveBeenCalled();
  });

  it('the Kysely read on the replica decides a plain model is served', async () => {
    dbMock.dbRead.model.findUnique.mockResolvedValue({ poi: true, userId: OWNER });
    q.getModelPoiAndOwner.mockResolvedValue({ poi: false, userId: OWNER } as never);
    expect(await getOwner()).toBe('served');
  });

  it('a missing model is served to the handler, as the Prisma null was', async () => {
    q.getModelPoiAndOwner.mockResolvedValue(undefined as never);
    expect(await getOwner()).toBe('served');
  });
});
