import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

// Every Buzz-moving bounty path against one in-memory bounty whose `FOR UPDATE` read is a real
// mutex held until the transaction callback settles, so two paths run concurrently serialize
// exactly as they do on Postgres. A path that skips the lock is not serialized, and the race
// tests below then see both paths move Buzz.

const { buzz, events } = vi.hoisted(() => ({
  buzz: {
    refundMultiAccountTransaction: vi.fn(),
    refundTransaction: vi.fn(),
    createBuzzTransaction: vi.fn(),
    createBuzzTransactionMany: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
  },
  events: [] as string[],
}));

// Hand-listed: the real buzz.service builds HTTP clients at load; these are the calls under test.
vi.mock('~/server/services/buzz.service', () => ({
  ...buzz,
  createMultiAccountBuzzTransaction: vi.fn(),
  getUserBuzzAccount: vi.fn(async () => [{ balance: 1_000_000 }]),
}));
// Hand-listed, as in bounty-locked-properties.service.test.ts: each pulls a large graph at load.
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({
  createEntityImages: vi.fn(async () => []),
  updateEntityImages: vi.fn(async () => []),
  enqueueImageIngestion: vi.fn(),
  invalidateManyImageExistence: vi.fn(),
}));
vi.mock('~/server/redis/caches', () => ({
  userBountyCountCache: { refresh: vi.fn() },
  userBountyEntryCountCache: { refresh: vi.fn() },
}));
vi.mock('~/server/search-index/SearchIndexUpdate', () => ({
  SearchIndexUpdate: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/email/templates', () => ({
  bountyRefundedEmail: { send: vi.fn() },
}));

const { awardBountyEntry } = await import('~/server/services/bountyEntry.service');
const { deleteBountyById, refundBounty, refundBountyBenefactorFunds, voidBountyForNsfw } =
  await import('~/server/services/bounty.service');

type Benefactor = {
  userId: number;
  bountyId: number;
  unitAmount: number;
  currency: 'BUZZ';
  buzzTransactionId: string[];
  awardedToId: number | null;
  awardedAt?: Date | null;
};
type BountyRow = {
  id: number;
  userId: number;
  complete: boolean;
  refunded: boolean;
  poi: boolean;
  availability: string;
  buzzType: string | null;
  nsfw: boolean;
  lockedProperties: string[];
  moderatorNsfwLevel: number | null;
};

let bounty: BountyRow | null;
let benefactors: Benefactor[];
const entry = { id: 10, bountyId: 4, userId: 8 };

function mutex() {
  let tail = Promise.resolve();
  return {
    acquire() {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const ready = tail.then(() => release);
      tail = tail.then(() => held);
      return ready;
    },
  };
}
let rowLock = mutex();
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const find = (userId: number) => benefactors.find((b) => b.userId === userId);

function transactionClient(held: (() => void)[]) {
  return {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (!sql.includes('FOR UPDATE')) throw new Error(`unexpected query: ${sql}`);
      held.push(await rowLock.acquire());
      return bounty ? [{ ...bounty, meta: null }] : [];
    },
    bountyEntry: {
      findUniqueOrThrow: async () => {
        await tick();
        return { ...entry, bounty: { complete: bounty?.complete ?? false } };
      },
    },
    bountyBenefactor: {
      findUnique: async ({ where }: { where: { bountyId_userId: { userId: number } } }) => {
        await tick();
        const b = find(where.bountyId_userId.userId);
        return b ? { ...b } : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { bountyId_userId: { userId: number } } }) => {
        await tick();
        const b = find(where.bountyId_userId.userId);
        if (!b) throw new Error('not found');
        return { ...b };
      },
      update: async ({
        where,
        data,
      }: {
        where: { bountyId_userId: { userId: number } };
        data: Partial<Benefactor>;
      }) => {
        await tick();
        const b = find(where.bountyId_userId.userId)!;
        Object.assign(b, data);
        return { ...b };
      },
      findFirst: async () => {
        await tick();
        const b = benefactors.find((x) => x.awardedToId === null);
        return b ? { userId: b.userId } : null;
      },
      findMany: async () => {
        await tick();
        return benefactors.map((b) => ({ ...b }));
      },
      count: async () => {
        await tick();
        return benefactors.filter((b) => b.awardedToId !== null).length;
      },
    },
    bounty: {
      update: async ({ data }: { data: Partial<BountyRow> }) => {
        await tick();
        Object.assign(bounty!, data);
        events.push('claim');
        return { ...bounty! };
      },
      delete: async () => {
        await tick();
        const deleted = bounty;
        bounty = null;
        events.push('claim');
        return deleted;
      },
    },
    file: { deleteMany: async () => ({ count: 0 }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  rowLock = mutex();
  bounty = {
    id: 4,
    userId: 5,
    complete: false,
    refunded: false,
    poi: false,
    availability: 'Public',
    buzzType: 'green',
    nsfw: false,
    lockedProperties: ['nsfw'],
    moderatorNsfwLevel: null,
  };
  benefactors = [
    {
      userId: 5,
      bountyId: 4,
      unitAmount: 100,
      currency: 'BUZZ',
      buzzTransactionId: ['bounty-4-5-1'],
      awardedToId: null,
    },
    {
      userId: 6,
      bountyId: 4,
      unitAmount: 50,
      currency: 'BUZZ',
      buzzTransactionId: ['bounty-4-6-2'],
      awardedToId: null,
    },
  ];

  loggingMock.logToAxiom.mockResolvedValue(undefined);
  dbMock.dbWrite.$transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const held: (() => void)[] = [];
    try {
      const result = await cb(transactionClient(held));
      events.push('commit');
      return result;
    } finally {
      held.forEach((release) => release());
    }
  });
  dbMock.dbWrite.bountyBenefactor.findMany.mockImplementation(
    async ({ where }: { where: { awardedToId?: null } }) =>
      benefactors
        .filter((b) => !('awardedToId' in where) || b.awardedToId === null)
        .map((b) => ({ ...b }))
  );
  dbMock.dbRead.bounty.findUniqueOrThrow.mockResolvedValue({
    id: 4,
    name: 'B',
    user: { id: 5, email: 'owner@example.com' },
  });
  dbMock.dbRead.bounty.findUnique.mockResolvedValue({ userId: 5, expiresAt: new Date() });

  const moved = (name: string) => async () => {
    events.push(name);
    return {};
  };
  buzz.refundMultiAccountTransaction.mockImplementation(moved('refund'));
  buzz.refundTransaction.mockImplementation(moved('refund'));
  buzz.createBuzzTransaction.mockImplementation(moved('buzz'));
  buzz.createBuzzTransactionMany.mockImplementation(moved('award'));
  buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
    { accountType: 'green', amount: 100 },
  ]);
});

const moved = (name: string) => events.filter((e) => e === name).length;

describe('an award racing a green-bounty void', () => {
  // `headStart` ticks let the first path get that far before the second begins, so the
  // cases between them cover every point the two could interleave at.
  const race = async (first: 'award' | 'void', headStart: number) => {
    const award = () => awardBountyEntry({ id: 10, userId: 5 });
    const voidIt = () => voidBountyForNsfw(4);
    const [a, b] = first === 'award' ? [award, voidIt] : [voidIt, award];
    const pa = a();
    for (let i = 0; i < headStart; i++) await tick();
    const results = await Promise.allSettled([pa, b()]);
    const [awardResult, voidResult] = first === 'award' ? results : [results[1], results[0]];
    return { awardResult, voidResult, awarded: moved('award') > 0, refunded: moved('refund') > 0 };
  };

  it.each(
    (['award', 'void'] as const).flatMap((first) =>
      [0, 1, 2, 3, 4, 6].map((headStart) => [first, headStart] as const)
    )
  )('%s first, %i ticks ahead: exactly one of them moves Buzz', async (first, headStart) => {
    const { awardResult, voidResult, awarded, refunded } = await race(first, headStart);
    expect(awarded, 'exactly one path moves Buzz').not.toBe(refunded);
    if (awarded) {
      expect(voidResult).toEqual({
        status: 'fulfilled',
        value: { voided: false, reason: 'in-payout' },
      });
      expect(bounty?.refunded).toBe(false);
    } else {
      expect(awardResult.status).toBe('rejected');
      expect(benefactors.every((b) => b.awardedToId === null)).toBe(true);
    }
  });

  it.each(['award', 'void'] as const)('%s wins with a clear head start', async (first) => {
    const { awarded } = await race(first, 6);
    expect(awarded).toBe(first === 'award');
  });
});

describe('voidBountyForNsfw', () => {
  it('claims under the lock, commits, then refunds every benefactor', async () => {
    expect(await voidBountyForNsfw(4)).toEqual({ voided: true, refundedUserIds: [5, 6] });
    expect(bounty).toMatchObject({ complete: true, refunded: true });
    expect(events).toEqual(['claim', 'commit', 'refund', 'refund']);
  });

  it('refunds nothing on a redelivery, while paying out, or without a creator benefactor', async () => {
    bounty!.refunded = true;
    expect(await voidBountyForNsfw(4)).toEqual({ voided: false, reason: 'already-refunded' });
    bounty!.refunded = false;
    bounty!.complete = true;
    expect(await voidBountyForNsfw(4)).toEqual({ voided: false, reason: 'in-payout' });
    bounty!.complete = false;
    benefactors = benefactors.filter((b) => b.userId !== 5);
    expect(await voidBountyForNsfw(4)).toEqual({ voided: false, reason: 'no-currency' });
    expect(moved('refund')).toBe(0);
  });
});

describe('refundBounty', () => {
  it('claims under the lock before any refund', async () => {
    await refundBounty({ id: 4, isModerator: true });
    expect(events).toEqual(['claim', 'commit', 'refund', 'refund']);
  });

  it('refuses a bounty already claimed, and moves no Buzz', async () => {
    bounty!.complete = true;
    await expect(refundBounty({ id: 4, isModerator: true })).rejects.toThrow();
    benefactors[1].awardedToId = 10;
    bounty!.complete = false;
    await expect(refundBounty({ id: 4, isModerator: true })).rejects.toThrow();
    expect(moved('refund')).toBe(0);
  });
});

describe('deleteBountyById', () => {
  it('refunds the creator after the delete commits', async () => {
    await deleteBountyById({ id: 4, isModerator: true });
    expect(events).toEqual(['claim', 'commit', 'refund']);
  });

  it('refunds nothing when a void claimed the bounty first', async () => {
    bounty!.complete = true;
    bounty!.refunded = true;
    await deleteBountyById({ id: 4, isModerator: true });
    expect(moved('refund')).toBe(0);
  });
});

describe('awardBountyEntry', () => {
  it('pays only after the award commits', async () => {
    await awardBountyEntry({ id: 10, userId: 5 });
    expect(events).toEqual(['commit', 'award']);
    expect(find(5)?.awardedToId).toBe(10);
  });

  it('refuses a refunded bounty read under the lock', async () => {
    bounty!.refunded = true;
    await expect(awardBountyEntry({ id: 10, userId: 5 })).rejects.toThrow();
    expect(moved('award')).toBe(0);
  });

  it('logs a payout that fails after the award committed', async () => {
    buzz.createBuzzTransactionMany.mockRejectedValue(new Error('buzz down'));
    await expect(awardBountyEntry({ id: 10, userId: 5 })).rejects.toThrow('buzz down');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', bountyId: 4, name: 'bounty-award' })
    );
  });
});

describe('refundBountyBenefactorFunds', () => {
  it('refunds only unawarded benefactors when asked', async () => {
    benefactors[0].awardedToId = 10;
    expect(
      await refundBountyBenefactorFunds({ bountyId: 4, currency: 'BUZZ', onlyUnawarded: true })
    ).toEqual([6]);
    expect(dbMock.dbWrite.bountyBenefactor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bountyId: 4, currency: 'BUZZ', awardedToId: null } })
    );
  });

  it('logs a failed refund with the bounty and carries on', async () => {
    buzz.refundMultiAccountTransaction
      .mockRejectedValueOnce(new Error('404'))
      .mockResolvedValueOnce({});
    expect(await refundBountyBenefactorFunds({ bountyId: 4, currency: 'BUZZ' })).toEqual([6]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bounty-refund', type: 'error', bountyId: 4, userId: 5 })
    );
  });
});
