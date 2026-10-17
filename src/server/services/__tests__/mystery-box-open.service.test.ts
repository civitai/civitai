import type * as Crypto from 'crypto';
import type * as EventShopItem from '~/server/events/event-shop-item';
import type * as RedisCaches from '~/server/redis/caches';
import type * as RosterSync from '~/server/events/points/roster-sync';
import { Prisma } from '@prisma/client';
import { computeBoxOdds } from '@civitai/shared/box-odds';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Opening a mystery box: one transaction under the holder's item-holder lock that draws from what the
// box still has for the holder, grants it, records the draw and removes the box. No money moves.

const { mocks } = vi.hoisted(() => ({
  mocks: {
    randomInt: vi.fn(),
    getEventBuyerTeam: vi.fn(),
    syncRoster: vi.fn(),
  },
}));

vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof Crypto>()),
  randomInt: mocks.randomInt,
}));
vi.mock('~/server/events/event-shop-item', async (importOriginal) => ({
  ...(await importOriginal<typeof EventShopItem>()),
  getEventBuyerTeam: mocks.getEventBuyerTeam,
}));
vi.mock('~/server/events/points/roster-sync', async (importOriginal) => ({
  ...(await importOriginal<typeof RosterSync>()),
  syncEventRosterMember: mocks.syncRoster,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  refreshOwnedStickerCache: vi.fn(async () => undefined),
}));

import { openMysteryBox } from '../mystery-box.service';
import { ITEM_HOLDER_LOCK_CLASS } from '../item-holder-lock';
import { dbMock } from '~/__tests__/mocks/db.mock';

const HOLDER = 1;
const OTHER_USER = 2;
const BOX_ID = 9;
const VERSION = 3;
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
  reward: { type: string; cosmeticId: number | null; cosmetic: { data: unknown } | null };
};
const hat = (n: number, tierId: number, data: unknown = {}): Content => ({
  id: n,
  boxDefinitionId: BOX_ID,
  tierId,
  rewardDefinitionId: 100 + n,
  enabled: true,
  reward: { type: 'cosmetic', cosmeticId: 1000 + n, cosmetic: { data } },
});

type ItemRow = { id: bigint; itemDefinitionId: number; holderId: number; sourceKey: string };
type Opening = Record<string, unknown> & { boxItemId: bigint; userId: number };

let world: {
  box: { id: number; type: string; status: string; version: number; params: unknown };
  tiers: { id: number; boxDefinitionId: number; weight: number; sortOrder: number }[];
  contents: Content[];
  owned: { userId: number; cosmeticId: number; claimKey: string; remaining?: number | null }[];
  items: ItemRow[];
  openings: Map<bigint, Opening>;
  log: string[];
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
    if (!sql.includes('"Item"') || !sql.includes('FOR UPDATE'))
      throw new Error(`unexpected ${sql}`);
    world.log.push('select:item');
    const [id, holderId] = values;
    return world.items.filter((i) => i.id === id && i.holderId === holderId);
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
  cosmetic: {
    findUnique: async ({ where }: { where: { id: number } }) => {
      const content = world.contents.find((c) => c.reward.cosmeticId === where.id);
      return content ? { data: content.reward.cosmetic?.data ?? null } : null;
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
    create: async ({ data }: { data: Opening }) => {
      if (world.openings.has(data.boxItemId)) throw p2002();
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

const holderBox = (id = BOX_ITEM, holderId = HOLDER): ItemRow => ({
  id,
  itemDefinitionId: BOX_ID,
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
    async ({ where }: { where: { id: bigint; holderId: number } }) => {
      world.log.push('read:held');
      const row = world.items.find((i) => i.id === where.id && i.holderId === where.holderId);
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
    const tx = makeTx(async () => {
      release = await acquireLock();
    });
    try {
      return await fn(tx);
    } finally {
      world.log.push('end');
      release?.();
    }
  });

  mocks.randomInt.mockImplementation(() => 0);
  mocks.getEventBuyerTeam.mockResolvedValue(undefined);
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
    const inTx = world.log.slice(world.log.indexOf(`lock:${ITEM_HOLDER_LOCK_CLASS},${HOLDER}`));
    expect(inTx[0]).toBe(`lock:${ITEM_HOLDER_LOCK_CLASS},${HOLDER}`);
    expect(inTx[1]).toBe('select:item');
    expect(world.log.filter((l) => l.startsWith('lock:'))).toHaveLength(1);
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
    world.contents = [
      hat(1, COMMON, { event: 'birthday', team: 'red' }),
      hat(2, COMMON, { event: 'birthday', team: 'blue' }),
      hat(3, RARE, { event: 'birthday', team: 'red' }),
    ];
    mocks.getEventBuyerTeam.mockResolvedValue('blue');

    const result = await open();

    expect(mocks.getEventBuyerTeam).toHaveBeenCalledWith('birthday', HOLDER);
    expect(result).toMatchObject({
      cosmeticId: 1002,
      odds: { eligibleWeight: 3, tierPoolSize: 1 },
    });
    // An event hat updates its owner's roster entry, after the open commits.
    expect(mocks.syncRoster).toHaveBeenCalledWith(HOLDER, {
      event: 'birthday',
      onlyIfListed: true,
    });
  });

  it('a consumable reward is granted with its uses', async () => {
    world.contents = [hat(1, COMMON, { uses: 5 })];
    await open();
    expect(world.owned).toEqual([expect.objectContaining({ cosmeticId: 1001, remaining: 5 })]);
  });

  it("a held box opens after its definition is archived: the box is the holder's", async () => {
    world.box.status = 'archived';
    await expect(open()).resolves.toMatchObject({ replayed: false });
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
  });

  it("another user's opened box is not answered", async () => {
    await open();
    await expect(open({ userId: OTHER_USER })).rejects.toThrow('not yours');
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

  it('a box edited since the holder saw it, before anything is drawn', async () => {
    await expect(open({ expectedVersion: VERSION - 1 })).rejects.toThrow('contents changed');
    nothingOpened();
    expect(mocks.randomInt).not.toHaveBeenCalled();
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
    expect(world.items).toHaveLength(1);
  });
});
