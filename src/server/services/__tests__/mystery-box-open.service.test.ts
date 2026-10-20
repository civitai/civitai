import type * as Crypto from 'crypto';
import type * as EventShopItem from '~/server/events/event-shop-item';
import type * as RedisCaches from '~/server/redis/caches';
import type * as RosterSync from '~/server/events/points/roster-sync';
import type * as LoadEvents from '~/server/events/load-events';
import { Prisma } from '@prisma/client';
import { computeBoxOdds } from '@civitai/shared/box-odds';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Opening a mystery box: one transaction under the holder's item-holder lock that draws from what the
// box still has for the holder, grants it, records the draw and removes the box. No money moves.

const { mocks, actual } = vi.hoisted(() => ({
  actual: {} as { getEventBuyerTeam?: typeof EventShopItem.getEventBuyerTeam },
  mocks: {
    randomInt: vi.fn(),
    getEventBuyerTeam: vi.fn(),
    loadEvents: vi.fn(),
    syncRoster: vi.fn(),
    refreshStickers: vi.fn(),
  },
}));

vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof Crypto>()),
  randomInt: mocks.randomInt,
}));
vi.mock('~/server/events/event-shop-item', async (importOriginal) => {
  const original = await importOriginal<typeof EventShopItem>();
  actual.getEventBuyerTeam = original.getEventBuyerTeam;
  return { ...original, getEventBuyerTeam: mocks.getEventBuyerTeam };
});
vi.mock('~/server/events/load-events', async (importOriginal) => ({
  ...(await importOriginal<typeof LoadEvents>()),
  loadEvents: mocks.loadEvents,
}));
vi.mock('~/server/events/points/roster-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof RosterSync>()),
  syncEventRosterMember: mocks.syncRoster,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  refreshOwnedStickerCache: mocks.refreshStickers,
}));

import { modGrantSourceKey } from '@civitai/shared/mystery-box';
import { openMysteryBox } from '../mystery-box.service';
import { ITEM_HOLDER_BUSY_MESSAGE, ITEM_HOLDER_LOCK_CLASS } from '../item-holder-lock';
import { modelQueryError, rawQueryError } from '~/test-utils/prismaLockTimeout';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const HOLDER = 1;
const OTHER_USER = 2;
const BOX_ID = 9;
// Distinct from every content id and roll in the fixtures, so swapped audit fields show.
const VERSION = 5;
const BOX_ITEM = 501n;
const SOURCE_KEY = 'item-purchase-v1-1-42-key';
// Common weighs 3, Rare 1. Ids run against sortOrder so the walk order is visible.
const COMMON = 7;
const RARE = 6;

type Content = {
  id: number;
  boxDefinitionId: number;
  tierId: number;
  rewardDefinitionId: number;
  enabled: boolean;
  reward: {
    type: string;
    cosmeticId: number | null;
    cosmetic: { data: unknown; type: string } | null;
  };
};
const hat = (
  n: number,
  tierId: number,
  data: unknown = {},
  type = 'ContentDecoration'
): Content => ({
  id: n,
  boxDefinitionId: BOX_ID,
  tierId,
  rewardDefinitionId: 100 + n,
  enabled: true,
  reward: { type: 'cosmetic', cosmeticId: 1000 + n, cosmetic: { data, type } },
});

type ItemRow = {
  id: bigint;
  itemDefinitionId: number;
  holderType: string;
  holderId: number;
  sourceKey: string;
};
type Opening = Record<string, unknown> & { boxItemId: bigint; userId: number };

let world: {
  box: { id: number; type: string; status: string; version: number; params: unknown };
  tiers: { id: number; boxDefinitionId: number; weight: number; sortOrder: number }[];
  contents: Content[];
  owned: { userId: number; cosmeticId: number; claimKey: string; remaining?: number | null }[];
  items: ItemRow[];
  openings: Map<bigint, Opening>;
  log: string[];
  /** Runs inside the transaction once the holder lock is held. */
  onLock?: () => void;
};
let lockTail: Promise<void>;

const acquireLock = () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const prev = lockTail;
  lockTail = prev.then(() => held);
  return prev.then(() => release);
};

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });

const lockTimeout = () => rawQueryError('55P03');

const definition = (id: number) => {
  if (id === world.box.id) return { ...world.box, cosmeticId: null };
  const content = world.contents.find((c) => c.rewardDefinitionId === id);
  return content ? { id, type: content.reward.type, cosmeticId: content.reward.cosmeticId } : null;
};
const project = <T extends Record<string, unknown>>(
  row: T | null,
  select?: Record<string, unknown>
) =>
  row && select
    ? (Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) as Partial<T>)
    : row;

const openingReader =
  (label: string) =>
  async ({ where }: { where: { boxItemId: bigint } }) => {
    world.log.push(label);
    return world.openings.get(where.boxItemId) ?? null;
  };

const makeTx = (onLock: () => Promise<void>) => ({
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join('?').includes('pg_advisory_xact_lock')) {
      world.log.push(`lock:${values.join(',')}`);
      await onLock();
    }
    return 1;
  },
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('"ItemDefinition"') && sql.includes('FOR SHARE')) {
      world.log.push('select:definition:share');
      const row = definition(values[0] as number);
      return row
        ? [
            {
              id: row.id,
              type: row.type,
              version: (row as { version?: number }).version,
              sellerId: (row as { sellerId?: number }).sellerId ?? null,
            },
          ]
        : [];
    }
    if (!sql.includes('"Item"') || !sql.includes('FOR UPDATE'))
      throw new Error(`unexpected ${sql}`);
    world.log.push('select:item');
    const [id, holderId] = values;
    const usersOnly = sql.includes(`"holderType" = 'user'`);
    return world.items.filter(
      (i) => i.id === id && i.holderId === holderId && (!usersOnly || i.holderType === 'user')
    );
  },
  itemDefinition: {
    findUnique: async ({
      where,
      select,
    }: {
      where: { id: number };
      select?: Record<string, boolean>;
    }) => {
      world.log.push('read:definition');
      return project(definition(where.id), select);
    },
  },
  boxContent: {
    findMany: async ({ where }: { where: { boxDefinitionId: number; enabled: boolean } }) => {
      world.log.push('read:contents');
      return world.contents.filter(
        (c) => c.boxDefinitionId === where.boxDefinitionId && c.enabled === where.enabled
      );
    },
  },
  boxTier: {
    findMany: async ({ where }: { where: { boxDefinitionId: number } }) => {
      world.log.push('read:tiers');
      return world.tiers
        .filter((t) => t.boxDefinitionId === where.boxDefinitionId)
        .map(({ id, weight, sortOrder }) => ({ id, weight, sortOrder }));
    },
  },
  userCosmetic: {
    findMany: async ({ where }: { where: { userId: number; cosmeticId: { in: number[] } } }) =>
      world.owned.filter(
        (o) => o.userId === where.userId && where.cosmeticId.in.includes(o.cosmeticId)
      ),
    create: async ({ data }: { data: (typeof world.owned)[number] }) => {
      const key = (o: typeof data) => `${o.userId}:${o.cosmeticId}:${o.claimKey}`;
      if (world.owned.some((o) => key(o) === key(data))) throw p2002();
      world.owned.push(data);
      world.log.push(`grant:${data.cosmeticId}`);
      return data;
    },
  },
  boxOpening: {
    findUnique: openingReader('read:opening'),
    findMany: async ({
      where,
    }: {
      where: { userId: number; boxDefinitionId: number; rewardType: string };
    }) =>
      [...world.openings.values()].filter(
        (o) =>
          o.userId === where.userId &&
          o.boxDefinitionId === where.boxDefinitionId &&
          o.rewardType === where.rewardType
      ),
    create: async ({ data }: { data: Opening }) => {
      if (world.openings.has(data.boxItemId)) throw p2002();
      // The migration's partial unique index: a user draws a given cosmetic from a box once.
      const once = (o: Opening) =>
        o.rewardType === 'cosmetic' && `${o.userId}:${o.boxDefinitionId}:${o.rewardDefinitionId}`;
      if ([...world.openings.values()].some((o) => once(o) && once(o) === once(data)))
        throw p2002();
      const row = { ...data, createdAt: new Date() };
      world.openings.set(data.boxItemId, row);
      world.log.push('record:opening');
      return row;
    },
  },
  item: {
    delete: async ({ where }: { where: { id: bigint } }) => {
      const index = world.items.findIndex((i) => i.id === where.id);
      if (index === -1) throw new Error('record to delete does not exist');
      world.log.push('delete:item');
      return world.items.splice(index, 1)[0];
    },
  },
});

const open = ({
  userId = HOLDER,
  boxItemId = BOX_ITEM,
  expectedVersion = VERSION,
  mysteryBoxEnabled = true,
  countryCode = 'US',
}: {
  userId?: number;
  boxItemId?: bigint;
  expectedVersion?: number;
  mysteryBoxEnabled?: boolean;
  countryCode?: string | null;
} = {}) =>
  openMysteryBox({
    userId,
    boxItemId: boxItemId.toString(),
    expectedVersion,
    mysteryBoxEnabled,
    countryCode,
  });

const holderBox = (id = BOX_ITEM, holderId = HOLDER, holderType = 'user'): ItemRow => ({
  id,
  itemDefinitionId: BOX_ID,
  holderType,
  holderId,
  sourceKey: `${SOURCE_KEY}-${id}`,
});

const nothingOpened = () => {
  expect(world.owned.filter((o) => o.claimKey.startsWith('box-open-'))).toEqual([]);
  expect(world.openings.size).toBe(0);
  expect(world.items.map((i) => i.id)).toContain(BOX_ITEM);
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  world = {
    box: { id: BOX_ID, type: 'box', status: 'published', version: VERSION, params: {} },
    tiers: [
      { id: COMMON, boxDefinitionId: BOX_ID, weight: 3, sortOrder: 0 },
      { id: RARE, boxDefinitionId: BOX_ID, weight: 1, sortOrder: 1 },
    ],
    contents: [hat(1, COMMON), hat(2, COMMON), hat(3, RARE)],
    owned: [],
    items: [holderBox()],
    openings: new Map(),
    log: [],
  };
  lockTail = Promise.resolve();

  dbMock.dbRead.keyValue.findUnique.mockReset();
  dbMock.dbRead.keyValue.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.item.findFirst.mockReset();
  dbMock.dbWrite.item.findFirst.mockImplementation(
    async ({ where }: { where: { id: bigint; holderType?: string; holderId: number } }) => {
      world.log.push('read:held');
      const row = world.items.find(
        (i) =>
          i.id === where.id &&
          i.holderId === where.holderId &&
          (where.holderType === undefined || i.holderType === where.holderType)
      );
      return row && { ...row, itemDefinition: { params: world.box.params } };
    }
  );
  dbMock.dbWrite.boxOpening.findUnique.mockReset();
  dbMock.dbWrite.boxOpening.findUnique.mockImplementation(openingReader('read:opening:outside'));
  dbMock.dbWrite.itemDefinition.findUnique.mockReset();
  dbMock.dbWrite.itemDefinition.findUnique.mockImplementation(
    async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) =>
      project(definition(where.id), select)
  );
  dbMock.dbWrite.$transaction.mockReset();
  dbMock.dbWrite.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    let release: (() => void) | undefined;
    // A failed transaction leaves nothing behind. Snapshot once the lock is held, which is when
    // Postgres would let this transaction see the world: a loser that waited behind a winner must
    // not roll back the winner's commit.
    let before: Pick<typeof world, 'owned' | 'items' | 'openings'> | undefined;
    const tx = makeTx(async () => {
      release = await acquireLock();
      before = {
        owned: [...world.owned],
        items: [...world.items],
        openings: new Map(world.openings),
      };
      world.onLock?.();
    });
    world.log.push('begin');
    try {
      return await fn(tx);
    } catch (error) {
      if (before) Object.assign(world, before);
      throw error;
    } finally {
      world.log.push('end');
      release?.();
    }
  });

  mocks.randomInt.mockImplementation(() => 0);
  mocks.getEventBuyerTeam.mockResolvedValue(undefined);
  mocks.refreshStickers.mockImplementation(async () => {
    world.log.push('refresh:stickers');
  });
  mocks.syncRoster.mockImplementation(async () => {
    world.log.push('sync:roster');
  });
  loggingMock.logToAxiom.mockClear();
});

describe('opening a mystery box', () => {
  it('grants the drawn hat, records the draw and removes the box', async () => {
    // tierRoll 3 of 4 lands past Common's 3 into Rare; Rare's only hat is hat 3.
    mocks.randomInt.mockReturnValueOnce(3).mockReturnValueOnce(0);

    const result = await open();

    expect(world.owned).toEqual([
      { userId: HOLDER, cosmeticId: 1003, claimKey: `box-open-${BOX_ITEM}`, remaining: null },
    ]);
    expect(world.openings.get(BOX_ITEM)).toEqual({
      boxItemId: BOX_ITEM,
      boxDefinitionId: BOX_ID,
      boxVersion: VERSION,
      userId: HOLDER,
      boxSourceKey: `${SOURCE_KEY}-${BOX_ITEM}`,
      tierId: RARE,
      contentId: 3,
      rewardDefinitionId: 103,
      rewardType: 'cosmetic',
      tierWeight: 1,
      eligibleWeight: 4,
      tierRoll: 3,
      tierPoolSize: 1,
      itemRoll: 0,
      rewardStatus: 'granted',
      createdAt: expect.any(Date),
    });
    expect(world.items).toEqual([]);
    expect(result).toEqual({
      boxItemId: BOX_ITEM.toString(),
      boxDefinitionId: BOX_ID,
      boxVersion: VERSION,
      tierId: RARE,
      contentId: 3,
      rewardDefinitionId: 103,
      rewardType: 'cosmetic',
      cosmeticId: 1003,
      odds: { tierWeight: 1, eligibleWeight: 4, tierPoolSize: 1 },
      replayed: false,
    });
  });

  it('rolls with crypto.randomInt below the eligible weight, then below the tier size', async () => {
    mocks.randomInt.mockReturnValueOnce(2).mockReturnValueOnce(1);
    const result = await open();
    expect(mocks.randomInt.mock.calls).toEqual([[4], [2]]);
    expect(result).toMatchObject({ tierId: COMMON, contentId: 2, cosmeticId: 1002 });
  });

  it('takes the holder lock first, before any row of the box is read', async () => {
    await open();
    const inTx = world.log.slice(world.log.indexOf('begin') + 1);
    expect(inTx.slice(0, 2)).toEqual([`lock:${ITEM_HOLDER_LOCK_CLASS},${HOLDER}`, 'select:item']);
    expect(world.log.filter((l) => l.startsWith('lock:'))).toHaveLength(1);
  });

  it('reads the box version FOR SHARE, after the Item lock, so a builder save waits for it', async () => {
    // Without FOR SHARE a builder save can commit between this open's version check and its draw.
    await open();
    const inTx = world.log.slice(world.log.indexOf('begin') + 1);
    expect(inTx.slice(0, 3)).toEqual([
      `lock:${ITEM_HOLDER_LOCK_CLASS},${HOLDER}`,
      'select:item',
      'select:definition:share',
    ]);
  });

  it('records odds the holder could have been shown: the audit fields recompute them', async () => {
    world.owned.push({ userId: HOLDER, cosmeticId: 1001, claimKey: 'shelf' });
    mocks.randomInt.mockReturnValueOnce(1).mockReturnValueOnce(0);

    await open();

    const opening = world.openings.get(BOX_ITEM)!;
    const shown = computeBoxOdds(
      world.tiers,
      [hat(2, COMMON), hat(3, RARE)].map((c) => ({ contentId: c.id, tierId: c.tierId }))
    );
    const tier = shown.tiers.find((t) => t.tierId === opening.tierId)!;
    expect(
      opening.tierWeight / (opening.eligibleWeight as number) / (opening.tierPoolSize as number)
    ).toBe(tier.itemProbability);
    expect(opening).toMatchObject({ eligibleWeight: 4, tierPoolSize: 1, contentId: 2 });
  });

  it('never draws again a hat drawn from this box before and since taken away', async () => {
    // Hat 1 came out of an earlier box; its UserCosmetic row was removed afterwards.
    world.openings.set(400n, {
      boxItemId: 400n,
      userId: HOLDER,
      boxDefinitionId: BOX_ID,
      rewardDefinitionId: 101,
      rewardType: 'cosmetic',
    });
    // Hat 2 drawn by another user, and from another box: neither takes it from this holder.
    world.openings.set(401n, {
      boxItemId: 401n,
      userId: OTHER_USER,
      boxDefinitionId: BOX_ID,
      rewardDefinitionId: 102,
      rewardType: 'cosmetic',
    });
    world.openings.set(402n, {
      boxItemId: 402n,
      userId: HOLDER,
      boxDefinitionId: BOX_ID + 1,
      rewardDefinitionId: 102,
      rewardType: 'cosmetic',
    });
    // Asks for the first Common hat left.
    mocks.randomInt.mockImplementation(() => 0);

    const result = await open();

    expect(result.cosmeticId).toBe(1002);
    expect(result.odds).toEqual({ tierWeight: 3, eligibleWeight: 4, tierPoolSize: 1 });
  });

  it('never draws a hat the holder owns from any source', async () => {
    world.owned.push(
      { userId: HOLDER, cosmeticId: 1001, claimKey: 'shelf' },
      { userId: HOLDER, cosmeticId: 1003, claimKey: 'box-open-1' }
    );
    // Every roll the draw can make: only hat 2 is left.
    mocks.randomInt.mockImplementation((max: number) => max - 1);
    const result = await open();
    expect(result.cosmeticId).toBe(1002);
    expect(mocks.randomInt.mock.calls).toEqual([[3], [1]]);
  });

  it("draws an event box from the holder's team only", async () => {
    world.box.params = { event: 'birthday' };
    // The hats name a different event than the box, so the roster sync's source shows.
    world.contents = [
      hat(1, COMMON, { event: 'birthday-hats', team: 'red' }),
      hat(2, COMMON, { event: 'birthday-hats', team: 'blue' }),
      hat(3, RARE, { event: 'birthday-hats', team: 'red' }),
    ];
    mocks.getEventBuyerTeam.mockResolvedValue('blue');

    const result = await open();

    expect(mocks.getEventBuyerTeam).toHaveBeenCalledWith('birthday', HOLDER);
    expect(result).toMatchObject({
      cosmeticId: 1002,
      odds: { eligibleWeight: 3, tierPoolSize: 1 },
    });
    // An event hat updates its owner's roster entry for the hat's event, after the open commits.
    expect(mocks.syncRoster.mock.calls).toEqual([
      [HOLDER, { event: 'birthday-hats', onlyIfListed: true }],
    ]);
  });

  it('a reward with no event touches no roster', async () => {
    await open();
    expect(mocks.syncRoster).not.toHaveBeenCalled();
  });

  it('a consumable sticker is granted with its uses and refreshes the owned-sticker cache', async () => {
    world.contents = [hat(1, COMMON, { uses: 5 }, 'Sticker')];
    await open();
    expect(world.owned).toEqual([expect.objectContaining({ cosmeticId: 1001, remaining: 5 })]);
    expect(mocks.refreshStickers.mock.calls).toEqual([[[HOLDER]]]);
  });

  it('a hat leaves the sticker cache alone', async () => {
    await open();
    expect(mocks.refreshStickers).not.toHaveBeenCalled();
  });

  it.each([
    ['the sticker', 0, { stickers: 1, roster: 0 }],
    ['the event hat', 1, { stickers: 0, roster: 1 }],
  ])('a mixed pool: drawing %s runs only its own follow-ups', async (_, itemRoll, expected) => {
    world.contents = [hat(1, COMMON, {}, 'Sticker'), hat(2, COMMON, { event: 'birthday-hats' })];
    mocks.randomInt.mockReturnValueOnce(0).mockReturnValueOnce(itemRoll);
    await open();
    expect(mocks.refreshStickers).toHaveBeenCalledTimes(expected.stickers);
    expect(mocks.syncRoster).toHaveBeenCalledTimes(expected.roster);
  });

  it('runs its follow-ups only after the transaction ends', async () => {
    world.contents = [hat(1, COMMON, { event: 'birthday-hats' }, 'Sticker')];
    await open();
    const end = world.log.lastIndexOf('end');
    expect(world.log.indexOf('refresh:stickers')).toBeGreaterThan(end);
    expect(world.log.indexOf('sync:roster')).toBeGreaterThan(end);
  });

  it('runs no follow-ups when the transaction fails late', async () => {
    world.contents = [hat(1, COMMON, { event: 'birthday-hats' }, 'Sticker')];
    const realTx = dbMock.dbWrite.$transaction.getMockImplementation()!;
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
      realTx(async (tx: ReturnType<typeof makeTx>) =>
        fn({
          ...tx,
          item: {
            delete: async () => {
              throw new Error('connection lost');
            },
          },
        })
      )
    );
    await expect(open()).rejects.toThrow('connection lost');
    nothingOpened();
    expect(mocks.refreshStickers).not.toHaveBeenCalled();
    expect(mocks.syncRoster).not.toHaveBeenCalled();
    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it('logs each draw once, and a replay not again', async () => {
    mocks.randomInt.mockReturnValueOnce(3).mockReturnValueOnce(0);
    await open();
    await open();
    expect(loggingMock.logToAxiom.mock.calls).toEqual([
      [
        expect.objectContaining({
          name: 'mystery-box-open',
          userId: HOLDER,
          boxItemId: BOX_ITEM.toString(),
          boxVersion: VERSION,
          tierId: RARE,
          contentId: 3,
          tierRoll: 3,
          itemRoll: 0,
          eligibleWeight: 4,
        }),
      ],
    ]);
  });

  it('a cache failure after commit does not fail the open', async () => {
    world.contents = [hat(1, COMMON, {}, 'Sticker')];
    mocks.refreshStickers.mockRejectedValue(new Error('redis down'));
    await expect(open()).resolves.toMatchObject({ cosmeticId: 1001, replayed: false });
    expect(world.items).toEqual([]);
  });

  it("a held box opens after its definition is archived: the box is the holder's", async () => {
    world.box.status = 'archived';
    await expect(open()).resolves.toMatchObject({ replayed: false });
  });
});

// A grant reaches a holder no purchase placed on a team: the open places them, before the lock.
describe('a holder who never joined the event', () => {
  const GRANTED = modGrantSourceKey('g1', HOLDER, 1);

  beforeEach(() => {
    world.items = [{ ...holderBox(), sourceKey: GRANTED }];
    world.box.params = { event: 'birthday' };
    world.contents = [
      hat(1, COMMON, { event: 'birthday', team: 'red' }),
      hat(2, COMMON, { event: 'birthday', team: 'blue' }),
      hat(3, RARE, { event: 'birthday', team: 'red' }),
    ];
    mocks.getEventBuyerTeam.mockImplementation(actual.getEventBuyerTeam!);
  });

  // Unsettled, the holder has no team and a strict read throws: an open that skips settling fails.
  const balancedEvent = (settle: () => Promise<string>) => {
    let placed: string | undefined;
    return {
      name: 'birthday',
      teams: ['red', 'blue'],
      settleBalancedTeam: vi.fn(async () => {
        world.log.push('settle');
        placed = await settle();
        return placed;
      }),
      getUserTeam: vi.fn(async () => {
        if (!placed) throw new Error('not on a team');
        return placed;
      }),
    };
  };

  it('is placed on a team by the open, before the lock, and draws from that team', async () => {
    const event = balancedEvent(async () => 'blue');
    mocks.loadEvents.mockResolvedValue([event]);

    const result = await open();

    expect(event.settleBalancedTeam.mock.calls).toEqual([[HOLDER]]);
    expect(event.getUserTeam).toHaveBeenCalledWith(HOLDER, { strict: true });
    expect(world.log.indexOf('settle')).toBeLessThan(
      world.log.findIndex((line) => line.startsWith('lock:'))
    );
    expect(result).toMatchObject({ cosmeticId: 1002, replayed: false });
    expect(world.openings.get(BOX_ITEM)).toMatchObject({
      userId: HOLDER,
      boxSourceKey: GRANTED,
      contentId: 2,
    });
    expect(world.items).toEqual([]);
  });

  it('keeps the box when no team can be confirmed for them', async () => {
    mocks.loadEvents.mockResolvedValue([
      balancedEvent(async () => {
        throw new Error('settle failed');
      }),
    ]);
    await expect(open()).rejects.toThrow("We couldn't confirm your team");
    nothingOpened();
  });

  it("keeps the box when its event isn't registered any more", async () => {
    mocks.loadEvents.mockResolvedValue([]);
    await expect(open()).rejects.toThrow(/^This item is not available$/);
    nothingOpened();
  });
});

describe('an open that already happened', () => {
  it('a retry answers the same opening and grants nothing more', async () => {
    const first = await open();
    const second = await open();

    expect(second).toEqual({ ...first, replayed: true });
    expect(world.owned).toHaveLength(1);
    expect(world.openings.size).toBe(1);
  });

  it('a double-click: two opens of one box at once grant once, and both answer it', async () => {
    const [a, b] = await Promise.all([open(), open()]);

    expect(world.owned).toHaveLength(1);
    expect(world.openings.size).toBe(1);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect({ ...a, replayed: true }).toEqual({ ...b, replayed: true });
    // The one that waited on the lock answers from the record: one draw, one log line.
    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(1);
  });

  it("another user's opened box is not answered", async () => {
    await open();
    await expect(open({ userId: OTHER_USER })).rejects.toThrow('not yours');
  });

  it('a retry after a moderator refunded it does not reveal the reward again', async () => {
    await open();
    world.openings.get(BOX_ITEM)!.rewardStatus = 'refunded';

    await expect(open()).rejects.toThrow('This box was refunded');
  });
});

describe('two different boxes opened at once', () => {
  it("the second sees the first one's grant and never draws the same hat", async () => {
    world.contents = [hat(1, COMMON), hat(2, COMMON)];
    world.tiers = [world.tiers[0]];
    world.items.push(holderBox(502n));
    // Both draws ask for the first hat left.
    mocks.randomInt.mockImplementation(() => 0);

    const results = await Promise.all([open(), open({ boxItemId: 502n })]);

    expect(results.map((r) => r.cosmeticId).sort()).toEqual([1001, 1002]);
    expect(world.owned.map((o) => o.cosmeticId).sort()).toEqual([1001, 1002]);
  });
});

describe('refusals keep the box', () => {
  it('a box the user does not hold', async () => {
    world.items = [holderBox(BOX_ITEM, OTHER_USER)];
    await expect(open()).rejects.toThrow('not yours');
    expect(world.owned).toEqual([]);
    expect(world.items).toHaveLength(1);
  });

  it('a box held by another kind of holder with the same id', async () => {
    world.items = [holderBox(BOX_ITEM, HOLDER, 'faction')];
    await expect(open()).rejects.toThrow('not yours');
    expect(world.owned).toEqual([]);
    expect(world.items).toHaveLength(1);
  });

  it("a creator's mystery pack, before anything is drawn", async () => {
    (world.box as { sellerId?: number }).sellerId = 10;
    await expect(open()).rejects.toThrow('cannot be opened');
    nothingOpened();
    expect(mocks.randomInt).not.toHaveBeenCalled();
  });

  it('an item that is not a box, before anything is drawn', async () => {
    world.box.type = 'cosmetic';
    await expect(open()).rejects.toThrow('cannot be opened');
    nothingOpened();
    expect(mocks.randomInt).not.toHaveBeenCalled();
  });

  it.each([[VERSION - 1], [VERSION + 1]])(
    'a box whose version is not the %s the holder saw, before anything is drawn',
    async (expectedVersion) => {
      await expect(open({ expectedVersion })).rejects.toThrow('contents changed');
      nothingOpened();
      expect(mocks.randomInt).not.toHaveBeenCalled();
    }
  );

  it('a box that left the holder between the first read and the lock', async () => {
    world.onLock = () => {
      world.items[0].holderType = 'faction';
    };
    await expect(open()).rejects.toThrow('not yours');
    expect(world.owned).toEqual([]);
    expect(world.openings.size).toBe(0);
  });

  it('a holder lock that times out answers busy', async () => {
    world.onLock = () => {
      throw lockTimeout();
    };
    await expect(open()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: ITEM_HOLDER_BUSY_MESSAGE,
    });
  });

  it('another database error under the lock is not answered as busy', async () => {
    world.onLock = () => {
      throw rawQueryError('40P01');
    };
    const error = await open().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it.each([
    [
      'times out answers busy',
      '55P03',
      { code: 'TOO_MANY_REQUESTS', message: ITEM_HOLDER_BUSY_MESSAGE },
    ],
    [
      'fails with another Postgres code is not answered as busy',
      '40P01',
      { name: 'PrismaClientUnknownRequestError' },
    ],
  ])('a model query under the lock that %s', async (_label, code, expected) => {
    const realTx = dbMock.dbWrite.$transaction.getMockImplementation()!;
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
      realTx(async (tx: ReturnType<typeof makeTx>) =>
        fn({
          ...tx,
          boxTier: {
            findMany: async () => {
              throw modelQueryError(code);
            },
          },
        })
      )
    );
    await expect(open()).rejects.toMatchObject(expected);
    nothingOpened();
  });

  it('a box with nothing left for the holder stays held', async () => {
    world.owned.push(
      ...[1001, 1002, 1003].map((cosmeticId) => ({ userId: HOLDER, cosmeticId, claimKey: 'x' }))
    );
    await expect(open()).rejects.toThrow("You've collected everything in this box");
    expect(world.items).toHaveLength(1);
    expect(world.openings.size).toBe(0);
  });

  it('the kill switch, before any read', async () => {
    await expect(open({ mysteryBoxEnabled: false })).rejects.toThrow('not available');
    nothingOpened();
    expect(world.log).toEqual([]);
  });

  it('a blocked region, and an unknown country while any is blocked', async () => {
    dbMock.dbRead.keyValue.findUnique.mockResolvedValue({ value: ['BE'] });
    await expect(open({ countryCode: 'BE' })).rejects.toThrow('not available in your region');
    await expect(open({ countryCode: null })).rejects.toThrow('not available in your region');
    nothingOpened();
    await expect(open({ countryCode: 'US' })).resolves.toMatchObject({ replayed: false });
  });

  it('the backstop unique index: refused as a retry, and the box is still held', async () => {
    const realTx = dbMock.dbWrite.$transaction.getMockImplementation()!;
    dbMock.dbWrite.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) =>
      realTx(async (tx: ReturnType<typeof makeTx>) =>
        fn({
          ...tx,
          boxOpening: {
            ...tx.boxOpening,
            create: async () => {
              throw p2002();
            },
          },
        })
      )
    );
    await expect(open()).rejects.toThrow('could not be opened');
    nothingOpened();
    expect(mocks.syncRoster).not.toHaveBeenCalled();
  });
});
