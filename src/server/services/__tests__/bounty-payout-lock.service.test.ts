import { BuzzApiError } from '@civitai/buzz';
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
const {
  deleteBountyById,
  refundBounty,
  refundBountyBenefactorFunds,
  retryUnsettledBountyPayouts,
  settleBountyPayout,
} = await import('~/server/services/bounty.service');

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
  meta?: unknown;
  payoutRecordedAt?: Date | null;
  payoutSettledAt?: Date | null;
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
      return bounty ? [{ meta: null, ...bounty }] : [];
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
        events.push('delete');
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
    async ({ where }: { where: { awardedToId?: null | { not: null } } }) =>
      benefactors
        .filter((b) =>
          !('awardedToId' in where)
            ? true
            : where.awardedToId === null
            ? b.awardedToId === null
            : b.awardedToId !== null
        )
        .map((b) => ({
          ...b,
          awartedTo: b.awardedToId === entry.id ? { userId: entry.userId } : null,
        }))
  );
  dbMock.dbWrite.bounty.findUnique.mockImplementation(async () => (bounty ? { ...bounty } : null));
  dbMock.dbWrite.bounty.updateMany.mockImplementation(
    async ({ data }: { data: Partial<BountyRow> }) => {
      if (bounty && !bounty.payoutSettledAt) Object.assign(bounty, data);
      return { count: 1 };
    }
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
  buzz.createBuzzTransactionMany.mockImplementation(async (transactions: unknown[]) => {
    events.push('award');
    return { transactions: transactions.map((_, i) => `t${i}`), conflicts: [] };
  });
  buzz.getMultiAccountTransactionsByPrefix.mockResolvedValue([
    { accountType: 'yellow', amount: 100 },
  ]);
});

const moved = (name: string) => events.filter((e) => e === name).length;

describe('an award racing a refund', () => {
  // `headStart` ticks let the first path get that far before the second begins, so the
  // cases between them cover every point the two could interleave at.
  const race = async (first: 'award' | 'refund', headStart: number) => {
    const award = () => awardBountyEntry({ id: 10, userId: 5 });
    const refund = () => refundBounty({ id: 4, isModerator: true });
    const [a, b] = first === 'award' ? [award, refund] : [refund, award];
    const pa = a();
    for (let i = 0; i < headStart; i++) await tick();
    const results = await Promise.allSettled([pa, b()]);
    const [awardResult, refundResult] = first === 'award' ? results : [results[1], results[0]];
    return {
      awardResult,
      refundResult,
      awarded: moved('award') > 0,
      refunded: moved('refund') > 0,
    };
  };

  it.each(
    (['award', 'refund'] as const).flatMap((first) =>
      [0, 1, 2, 3, 4, 6].map((headStart) => [first, headStart] as const)
    )
  )('%s first, %i ticks ahead: exactly one of them moves Buzz', async (first, headStart) => {
    const { awardResult, refundResult, awarded, refunded } = await race(first, headStart);
    expect(awarded, 'exactly one path moves Buzz').not.toBe(refunded);
    if (awarded) {
      expect(refundResult.status).toBe('rejected');
      expect(bounty?.refunded).toBe(false);
    } else {
      expect(awardResult.status).toBe('rejected');
      expect(benefactors.every((b) => b.awardedToId === null)).toBe(true);
    }
  });

  it.each(['award', 'refund'] as const)('%s wins with a clear head start', async (first) => {
    const { awarded } = await race(first, 6);
    expect(awarded).toBe(first === 'award');
  });
});

describe('refundBounty', () => {
  it('claims under the lock before any refund, then marks the refund settled', async () => {
    await refundBounty({ id: 4, isModerator: true });
    expect(events).toEqual(['claim', 'commit', 'refund', 'refund']);
    expect(bounty?.payoutRecordedAt).toBeInstanceOf(Date);
    expect(bounty?.payoutSettledAt).toBeInstanceOf(Date);
  });

  it('refuses a bounty already claimed, and moves no Buzz', async () => {
    bounty!.complete = true;
    await expect(refundBounty({ id: 4, isModerator: true })).rejects.toThrow();
    benefactors[1].awardedToId = 10;
    bounty!.complete = false;
    await expect(refundBounty({ id: 4, isModerator: true })).rejects.toThrow();
    expect(moved('refund')).toBe(0);
  });

  it('leaves a refund that failed unsettled, for the retry job', async () => {
    buzz.refundMultiAccountTransaction.mockRejectedValueOnce(new Error('buzz down'));
    await refundBounty({ id: 4, isModerator: true });
    expect(bounty?.payoutRecordedAt).toBeInstanceOf(Date);
    expect(bounty?.payoutSettledAt).toBeUndefined();
  });
});

describe('deleteBountyById', () => {
  it('refunds the creator before the row, and its benefactors, are deleted', async () => {
    await deleteBountyById({ id: 4, isModerator: true });
    expect(events).toEqual(['claim', 'commit', 'refund', 'refund', 'delete', 'commit']);
  });

  it('keeps the bounty when the refund fails, so a retry still has what it needs', async () => {
    buzz.refundMultiAccountTransaction.mockRejectedValueOnce(new Error('buzz down'));
    await expect(deleteBountyById({ id: 4, isModerator: true })).rejects.toThrow('not deleted');
    expect(bounty).not.toBeNull();
    expect(bounty?.refunded).toBe(true);
    expect(moved('delete')).toBe(0);
  });

  it('settles a recorded but unpaid refund before deleting', async () => {
    Object.assign(bounty!, { complete: true, refunded: true, payoutRecordedAt: new Date() });
    await deleteBountyById({ id: 4, isModerator: true });
    expect(events).toEqual(['commit', 'refund', 'refund', 'delete', 'commit']);
  });

  it('refunds nothing when the bounty was refunded before payouts were recorded', async () => {
    bounty!.complete = true;
    bounty!.refunded = true;
    await deleteBountyById({ id: 4, isModerator: true });
    expect(moved('refund')).toBe(0);
    expect(bounty).toBeNull();
  });
});

describe('awardBountyEntry', () => {
  it('records the award, then pays under a bounty-scoped key and marks it settled', async () => {
    await awardBountyEntry({ id: 10, userId: 5 });
    expect(events).toEqual(['claim', 'commit', 'award']);
    expect(find(5)?.awardedToId).toBe(10);
    expect(buzz.createBuzzTransactionMany).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({
        toAccountId: entry.userId,
        toAccountType: 'yellow',
        amount: 100,
        externalTransactionId: 'bounty-award-b4-yellow',
      }),
    ]);
    expect(bounty?.payoutSettledAt).toBeInstanceOf(Date);
  });

  it('refuses a refunded bounty read under the lock', async () => {
    bounty!.refunded = true;
    await expect(awardBountyEntry({ id: 10, userId: 5 })).rejects.toThrow();
    expect(moved('award')).toBe(0);
  });

  // A bounty hidden for depicting a real person never pays out, by any path.
  it('refuses a bounty hidden by an open text-scan poi flag', async () => {
    Object.assign(bounty!, {
      poi: true,
      availability: 'Private',
      meta: { textScanFlags: { poi: { workflowId: 'wf', reason: 'r', textHash: 'h' } } },
    });
    await expect(awardBountyEntry({ id: 10, userId: 5 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(find(5)?.awardedToId).toBeNull();
    expect(moved('award')).toBe(0);
  });

  it('keeps a recorded award whose payout failed unsettled and logs it, without failing the award', async () => {
    buzz.createBuzzTransactionMany.mockRejectedValueOnce(new Error('buzz down'));
    await expect(awardBountyEntry({ id: 10, userId: 5 })).resolves.toBeDefined();
    expect(bounty?.payoutRecordedAt).toBeInstanceOf(Date);
    expect(bounty?.payoutSettledAt).toBeUndefined();
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', bountyId: 4, name: 'bounty-award' })
    );
  });

  it('pays nothing when a charge lookup fails, rather than part of the award', async () => {
    buzz.getMultiAccountTransactionsByPrefix.mockRejectedValueOnce(new Error('buzz down'));
    await awardBountyEntry({ id: 10, userId: 5 });
    expect(buzz.createBuzzTransactionMany).not.toHaveBeenCalled();
    expect(bounty?.payoutSettledAt).toBeUndefined();
  });
});

describe('settleBountyPayout', () => {
  beforeEach(() => {
    benefactors[0].awardedToId = 10;
    benefactors.splice(1);
    Object.assign(bounty!, { complete: true, payoutRecordedAt: new Date() });
  });

  it('counts a key the ledger already holds as paid', async () => {
    buzz.createBuzzTransactionMany.mockResolvedValueOnce({ transactions: [], conflicts: ['c'] });
    expect(await settleBountyPayout(4)).toBe(true);
    expect(bounty?.payoutSettledAt).toBeInstanceOf(Date);
  });

  it('does not settle a batch the ledger neither made nor recognised', async () => {
    buzz.createBuzzTransactionMany.mockResolvedValueOnce({ transactions: [], conflicts: [] });
    expect(await settleBountyPayout(4)).toBe(false);
    expect(bounty?.payoutSettledAt).toBeUndefined();
  });

  it('repeats the same keys on a retry', async () => {
    buzz.createBuzzTransactionMany.mockRejectedValueOnce(new Error('buzz down'));
    expect(await settleBountyPayout(4)).toBe(false);
    expect(await settleBountyPayout(4)).toBe(true);
    const [first, retry] = buzz.createBuzzTransactionMany.mock.calls.map(([txs]) =>
      txs.map((t: { externalTransactionId: string }) => t.externalTransactionId)
    );
    expect(retry).toEqual(first);
  });

  it('does nothing for a payout recorded before this ledger, or already settled', async () => {
    bounty!.payoutRecordedAt = null;
    expect(await settleBountyPayout(4)).toBe(true);
    Object.assign(bounty!, { payoutRecordedAt: new Date(), payoutSettledAt: new Date() });
    expect(await settleBountyPayout(4)).toBe(true);
    expect(moved('award')).toBe(0);
  });

  it('pays a legacy supporter without transaction ids in yellow, under the same key', async () => {
    benefactors[0].buzzTransactionId = [];
    expect(await settleBountyPayout(4)).toBe(true);
    expect(buzz.getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
    expect(buzz.createBuzzTransactionMany).toHaveBeenCalledWith([
      expect.objectContaining({ amount: 100, externalTransactionId: 'bounty-award-b4-yellow' }),
    ]);
  });

  it('treats a refund the Buzz service already made (404/409) as done', async () => {
    Object.assign(bounty!, { refunded: true });
    benefactors[0].awardedToId = null;
    buzz.refundMultiAccountTransaction.mockRejectedValueOnce(new BuzzApiError(409, 'Conflict'));
    expect(await settleBountyPayout(4)).toBe(true);
    expect(bounty?.payoutSettledAt).toBeInstanceOf(Date);
  });
});

describe('retryUnsettledBountyPayouts', () => {
  it('retries payouts recorded more than ten minutes ago and not yet settled', async () => {
    const now = new Date('2026-10-06T12:00:00Z');
    benefactors[0].awardedToId = 10;
    Object.assign(bounty!, { complete: true, payoutRecordedAt: new Date(0) });
    dbMock.dbWrite.bounty.findMany.mockResolvedValueOnce([{ id: 4 }]);

    expect(await retryUnsettledBountyPayouts({ now })).toEqual({ settled: 1 });

    const { where } = dbMock.dbWrite.bounty.findMany.mock.calls[0][0];
    expect(where).toEqual({
      id: { gt: 0 },
      payoutRecordedAt: { not: null, lte: new Date('2026-10-06T11:50:00Z') },
      payoutSettledAt: null,
    });
    expect(bounty?.payoutSettledAt).toBeInstanceOf(Date);
  });
});

describe('refundBountyBenefactorFunds', () => {
  it('refunds only unawarded benefactors when asked', async () => {
    benefactors[0].awardedToId = 10;
    expect(
      await refundBountyBenefactorFunds({ bountyId: 4, currency: 'BUZZ', onlyUnawarded: true })
    ).toEqual({ refunded: [6], failed: [] });
    expect(dbMock.dbWrite.bountyBenefactor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bountyId: 4, currency: 'BUZZ', awardedToId: null } })
    );
  });

  it('logs a failed refund with the bounty and carries on', async () => {
    buzz.refundMultiAccountTransaction
      .mockRejectedValueOnce(new Error('buzz down'))
      .mockResolvedValueOnce({});
    expect(await refundBountyBenefactorFunds({ bountyId: 4, currency: 'BUZZ' })).toEqual({
      refunded: [6],
      failed: [5],
    });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bounty-refund', type: 'error', bountyId: 4, userId: 5 })
    );
  });

  it('skips a legacy supporter on a retry, since its refund cannot be deduplicated', async () => {
    benefactors[0].buzzTransactionId = [];
    expect(
      await refundBountyBenefactorFunds({ bountyId: 4, currency: 'BUZZ', includeLegacy: false })
    ).toEqual({ refunded: [6], failed: [] });
    expect(moved('buzz')).toBe(0);
  });
});
