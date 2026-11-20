import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads5 from '@civitai/db-queries/hot-reads-5';
import type * as LagHelpers from '~/server/db/db-lag-helpers';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
vi.mock('@civitai/db-queries/hot-reads-5', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads5>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
const { getDbWithoutLag, getKyselyWithoutLag } = vi.hoisted(() => ({
  getDbWithoutLag: vi.fn(),
  getKyselyWithoutLag: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  getDbWithoutLag,
  getKyselyWithoutLag,
}));

import * as queries from '@civitai/db-queries/hot-reads-5';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));

const ID = 7301;
const USER = 7402;
const OWNER = 7503;
const POST = 7604;

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  getDbWithoutLag.mockReset().mockResolvedValue(dbMock.dbRead);
  getKyselyWithoutLag.mockReset().mockResolvedValue(kyselyRead);
});

describe('getEntityCollaborators', () => {
  const load = async () =>
    (await import('~/server/services/entity-collaborator.service')).getEntityCollaborators;
  const collaboratorUser = { id: USER, username: 'collab', cosmetics: [] };

  it('shows a pending collaborator to the post owner, not to a signed-out viewer', async () => {
    q.listPostCollaborators.mockResolvedValue([
      {
        postUserId: OWNER,
        collaboratorUserId: USER,
        entityId: POST,
        entityType: 'Post',
        status: 'Pending',
      },
    ] as never);
    dbMock.dbRead.user.findMany.mockResolvedValue([collaboratorUser]);
    await expect((await load())({ entityId: POST, entityType: 'Post' })).resolves.toEqual([]);
    await expect(
      (
        await load()
      )({ entityId: POST, entityType: 'Post', userId: OWNER })
    ).resolves.toEqual([
      { user: collaboratorUser, entityId: POST, entityType: 'Post', status: 'Pending' },
    ]);
  });
});

describe('getHomeBlockById', () => {
  const load = async () => (await import('~/server/services/home-block.service')).getHomeBlockById;
  const read = async () =>
    (await load())({ id: ID, viewer: {} as never } as never).catch(() => undefined);

  it('a row missing on the replica falls back to the primary', async () => {
    q.getHomeBlockRow.mockResolvedValue(undefined as never);
    await read();
    expect(dbMock.dbWrite.homeBlock.findUnique).toHaveBeenCalledTimes(1);
  });

  it('a replica error falls back to the primary', async () => {
    q.getHomeBlockRow.mockRejectedValue(new Error('replica down') as never);
    await read();
    expect(dbMock.dbWrite.homeBlock.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('getModelCollectionShowcaseHandler', () => {
  it('a missing model is a not-found error', async () => {
    const { getModelCollectionShowcaseHandler } = await import(
      '~/server/controllers/model.controller'
    );
    q.getModelMeta.mockResolvedValue(undefined as never);
    await expect(
      getModelCollectionShowcaseHandler({ input: { id: ID }, ctx: {} as never })
    ).rejects.toThrow(`No model with id ${ID}`);
  });
});
