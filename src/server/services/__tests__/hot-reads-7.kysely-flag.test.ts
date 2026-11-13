import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import type * as HotReads7 from '@civitai/db-queries/hot-reads-7';
import type * as MysteryBoxService from '~/server/services/mystery-box.service';

// The Kysely/Prisma switch. FLIPT_FEATURE_FLAGS stays real, so the key asserted below is the one
// production evaluates.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: vi.fn(),
}));
// Every hot-read-7 statement stubbed: their rows against Prisma's are compared in
// hot-reads-7.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/hot-reads-7', async (importOriginal) => {
  const actual = await importOriginal<typeof HotReads7>();
  return Object.fromEntries(Object.keys(actual).map((name) => [name, vi.fn()]));
});
// The Inventory's country gate, so the held-box read is reached.
const { mysteryBoxesHiddenIn } = vi.hoisted(() => ({ mysteryBoxesHiddenIn: vi.fn() }));
vi.mock('~/server/services/mystery-box.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MysteryBoxService>()),
  mysteryBoxesHiddenIn,
}));

import * as queries from '@civitai/db-queries/hot-reads-7';
import { dbMock, resetSharedMocks } from '~/__tests__/mocks';
import { kyselyRead, kyselyWrite } from '~/server/db/kyselyDb';
import { isFlipt } from '~/server/flipt/client';

/**
 * Each call site behind `kysely-hot-reads-7`: the flag is evaluated by its key, with no entity or
 * context, once per call; OFF reads through Prisma only, exactly as before; ON reads through
 * Kysely on the replica client and returns a value that can only have come from the Kysely row
 * (each ON fixture differs from the OFF one). Row parity against a real database is in
 * hot-reads-7.kysely-parity.test.ts.
 */

const flag = vi.mocked(isFlipt);
const q = vi.mocked(queries);
const kyselyReads = () => Object.values(q).filter((fn) => vi.isMockFunction(fn));
const FLAG = 'kysely-hot-reads-7';

// Pairwise distinct, and distinct from every count below.
const POST = 9101;
const POST_2 = 9102;
const MODEL = 9201;
const MODEL_2 = 9202;
const VERSION_OFF = 9301;
const VERSION_ON = 9302;
const USER = 9401;
const BOX = 9501;

const expectNoKyselyRead = () => {
  for (const read of kyselyReads()) expect(read).not.toHaveBeenCalled();
};

beforeEach(() => {
  resetSharedMocks();
  for (const fn of kyselyReads()) fn.mockReset();
  flag.mockReset().mockResolvedValue(false);
  mysteryBoxesHiddenIn.mockReset().mockResolvedValue(false);
});

describe('control', () => {
  it('the routing checks below can tell the two Kysely clients apart', () => {
    expect(kyselyRead).not.toBe(kyselyWrite);
  });
});

describe('getSfwModelNames', () => {
  const load = async () =>
    (await import('~/server/services/model-sfw-face.service')).getSfwModelNames;

  it('OFF: one Prisma read on the replica', async () => {
    dbMock.dbRead.model.findMany.mockResolvedValue([{ id: MODEL, sfwName: 'off' }]);
    const names = await (await load())([MODEL, MODEL_2, MODEL], true);
    expect([...names]).toEqual([[MODEL, 'off']]);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.model.findMany.mock.calls[0][0]).toEqual({
      where: { id: { in: [MODEL, MODEL_2] }, sfwName: { not: null } },
      select: { id: true, sfwName: true },
    });
    expectNoKyselyRead();
  });

  it('ON: one Kysely read on the replica, whose rows are the result', async () => {
    flag.mockResolvedValue(true);
    q.listModelSfwNames.mockResolvedValue([{ id: MODEL_2, sfwName: 'on' }] as never);
    const names = await (await load())([MODEL, MODEL_2], true);
    expect([...names]).toEqual([[MODEL_2, 'on']]);
    expect(q.listModelSfwNames.mock.calls).toEqual([[kyselyRead, [MODEL, MODEL_2]]]);
    expect(q.listModelSfwNames.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.model.findMany).not.toHaveBeenCalled();
  });

  it('a viewer shown no .com face reads nothing and evaluates no flag', async () => {
    await expect((await load())([MODEL], false)).resolves.toEqual(new Map());
    expect(flag).not.toHaveBeenCalled();
    expect(dbMock.dbRead.model.findMany).not.toHaveBeenCalled();
    expectNoKyselyRead();
  });
});

describe("the post-version cache's lookup", () => {
  const load = async () =>
    (await import('~/server/services/model.service')).lookupPostModelVersions;

  it('OFF: one Prisma read on the replica', async () => {
    dbMock.dbRead.post.findMany.mockResolvedValue([
      { id: POST, modelVersionId: VERSION_OFF },
      { id: POST_2, modelVersionId: null },
    ]);
    await expect((await load())([POST, POST_2])).resolves.toEqual({
      [POST]: { id: POST, modelVersionId: VERSION_OFF },
      [POST_2]: { id: POST_2, modelVersionId: null },
    });
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.post.findMany.mock.calls[0][0]).toEqual({
      where: { id: { in: [POST, POST_2] } },
      select: { id: true, modelVersionId: true },
    });
    expectNoKyselyRead();
  });

  it('ON: one Kysely read on the replica, whose rows are the result', async () => {
    flag.mockResolvedValue(true);
    q.listPostModelVersionIds.mockResolvedValue([
      { id: POST, modelVersionId: VERSION_ON },
    ] as never);
    await expect((await load())([POST, POST_2])).resolves.toEqual({
      [POST]: { id: POST, modelVersionId: VERSION_ON },
    });
    expect(q.listPostModelVersionIds.mock.calls).toEqual([[kyselyRead, [POST, POST_2]]]);
    expect(q.listPostModelVersionIds.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.post.findMany).not.toHaveBeenCalled();
  });
});

describe("the Inventory's held box counts (countHeldMysteryBoxes)", () => {
  const load = async () =>
    (await import('~/server/services/mystery-box-inventory.service')).countHeldMysteryBoxes;
  const viewer = { userId: USER, mysteryBoxEnabled: true, countryCode: 'US' };
  const box = {
    id: BOX,
    type: 'box',
    status: 'published',
    params: {},
    version: 1,
    name: 'Box',
    description: null,
  };

  it('OFF: the Prisma groupBy on the replica, filtered to shown boxes', async () => {
    dbMock.dbRead.item.groupBy.mockResolvedValue([
      { itemDefinitionId: BOX, _count: { _all: 2 } },
    ] as never);
    dbMock.dbRead.itemDefinition.findMany.mockResolvedValue([box] as never);
    await expect((await load())(viewer)).resolves.toBe(2);
    expect(flag.mock.calls).toEqual([[FLAG]]);
    expect(dbMock.dbRead.item.groupBy.mock.calls[0][0]).toEqual({
      by: ['itemDefinitionId'],
      where: {
        holderType: 'user',
        holderId: USER,
        itemDefinition: { type: 'box', status: { in: ['published', 'archived'] } },
      },
      _count: { _all: true },
    });
    expectNoKyselyRead();
  });

  it('ON: one Kysely read on the replica, whose counts are the result', async () => {
    flag.mockResolvedValue(true);
    q.countHeldItemsByDefinitionId.mockResolvedValue([
      { itemDefinitionId: BOX, count: 5 },
    ] as never);
    dbMock.dbRead.itemDefinition.findMany.mockResolvedValue([box] as never);
    await expect((await load())(viewer)).resolves.toBe(5);
    expect(q.countHeldItemsByDefinitionId.mock.calls).toEqual([
      [
        kyselyRead,
        { holderType: 'user', holderId: USER, type: 'box', statuses: ['published', 'archived'] },
      ],
    ]);
    expect(q.countHeldItemsByDefinitionId.mock.calls[0][0]).toBe(kyselyRead);
    expect(dbMock.dbRead.item.groupBy).not.toHaveBeenCalled();
  });

  it('ON, nothing held: no definition read, as OFF', async () => {
    flag.mockResolvedValue(true);
    q.countHeldItemsByDefinitionId.mockResolvedValue([] as never);
    await expect((await load())(viewer)).resolves.toBe(0);
    expect(dbMock.dbRead.itemDefinition.findMany).not.toHaveBeenCalled();
  });
});
