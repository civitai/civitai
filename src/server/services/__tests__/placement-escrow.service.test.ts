import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLACEMENT_SPEND_TYPES } from '~/shared/constants/placement.constants';

const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();
const createBuzzTransaction = vi.fn();

vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
  createBuzzTransaction,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

// A real mutex, not a pass-through: the lock is what stops two callers both
// reaching the Buzz call after one has claimed the ledger row, so a double that
// always grants it would hide the defect it exists to prevent.
const heldLocks = new Set<string>();
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (options: { key: string }, operation: () => Promise<unknown>) => {
    if (heldLocks.has(options.key)) return null;
    heldLocks.add(options.key);
    try {
      return await operation();
    } finally {
      heldLocks.delete(options.key);
    }
  },
}));

/**
 * A stand-in for the two tables, honouring the one property the whole design
 * rests on: UNIQUE (placementId, kind). Without that the ledger is just logging.
 */
const db = {
  placements: new Map<number, Record<string, unknown>>(),
  legs: new Map<
    string,
    {
      placementId: number;
      kind: string;
      amount: number;
      transactionId: string | null;
      createdAt: Date;
    }
  >(),
};

type LedgerQuery = {
  where: Record<string, { in?: string[]; not?: string; lt?: Date } | number | null | undefined>;
  distinct?: string[];
  take?: number;
};

const legKey = (placementId: number, kind: string) => `${placementId}:${kind}`;

vi.mock('~/server/db/client', () => ({
  dbWrite: {
    placement: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: number } }) => db.placements.get(where.id) ?? null
      ),
      findMany: vi.fn(async ({ take }: { take?: number }) =>
        [...db.placements.values()]
          .filter(
            (p) => p.status === 'pending' && p.expiresAt && (p.expiresAt as Date) <= new Date()
          )
          .slice(0, take ?? 100)
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const row = db.placements.get(where.id as number);
          // Every key in `where` has to match, so adding a predicate to the real
          // query cannot silently become a no-op against this double.
          const matches =
            !!row &&
            Object.entries(where).every(([key, value]) => key === 'id' || row[key] === value);
          if (!matches) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
      ),
    },
    placementTransaction: {
      create: vi.fn(
        async ({ data }: { data: { placementId: number; kind: string; amount: number } }) => {
          const key = legKey(data.placementId, data.kind);
          if (db.legs.has(key))
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            });
          const row = { ...data, transactionId: null, createdAt: new Date(0) };
          db.legs.set(key, row);
          return row;
        }
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { placementId_kind: { placementId: number; kind: string } } }) =>
          db.legs.get(legKey(where.placementId_kind.placementId, where.placementId_kind.kind)) ??
          null
      ),
      findMany: vi.fn(async ({ where, distinct, take }: LedgerQuery) => {
        const rows = [...db.legs.values()].filter((leg) => {
          if (where.placementId !== undefined && leg.placementId !== where.placementId)
            return false;
          if (where.kind?.in && !where.kind.in.includes(leg.kind)) return false;
          if (where.kind?.not && leg.kind === where.kind.not) return false;
          if (where.transactionId === null && leg.transactionId !== null) return false;
          return true;
        });
        const withAge = rows.filter((leg) =>
          where.createdAt?.lt ? leg.createdAt < where.createdAt.lt : true
        );
        const deduped = distinct
          ? withAge.filter(
              (leg, i) => withAge.findIndex((o) => o.placementId === leg.placementId) === i
            )
          : withAge;
        return take ? deduped.slice(0, take) : deduped;
      }),
      createMany: vi.fn(
        async ({ data }: { data: { placementId: number; kind: string; amount: number }[] }) => {
          for (const row of data) {
            const key = legKey(row.placementId, row.kind);
            if (!db.legs.has(key))
              db.legs.set(key, { ...row, transactionId: null, createdAt: new Date(0) });
          }
          return { count: data.length };
        }
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { placementId_kind: { placementId: number; kind: string } };
          data: { transactionId: string | null };
        }) => {
          const row = db.legs.get(
            legKey(where.placementId_kind.placementId, where.placementId_kind.kind)
          );
          if (row) row.transactionId = data.transactionId;
          return row;
        }
      ),
    },
  },
}));

const configState = { rate: 0.3, shares: { seller: 0, platform: 0.3 } };
vi.mock('~/server/services/placement.service', () => ({
  getPlacementConfig: async () => ({
    declineFeeRate: () => configState.rate,
    expiryHours: () => 48,
    priceCapTiers: () => [],
    approvalShares: () => configState.shares,
  }),
}));
const storedRate = (rate: number) => (configState.rate = rate);
const storedShares = (shares: { seller: number; platform: number }) =>
  (configState.shares = shares);

const { holdPlacementEscrow, settlePlacement, expirePlacements, sweepUnpaidLegs } = await import(
  '~/server/services/placement-escrow.service'
);

const OWNER = 10;
const PLACER = 20;
const SELLER = 30;

const givenPlacement = (overrides: Record<string, unknown> = {}) => {
  const placement = {
    id: 1,
    sellerId: null,
    surface: 'sticker',
    targetType: 'image',
    targetId: 99,
    ownerId: OWNER,
    placerId: PLACER,
    status: 'pending',
    removedBy: null,
    amount: 1000,
    expiresAt: null,
    resolvedAt: null,
    resolvedById: null,
    ...overrides,
  };
  db.placements.set(placement.id as number, placement);
  return placement;
};

const legsFor = (placementId: number) =>
  Object.fromEntries(
    [...db.legs.values()]
      .filter((l) => l.placementId === placementId)
      .map((l) => [l.kind, l.amount])
  );

const moneyMoved = () =>
  createBuzzTransaction.mock.calls.length +
  createMultiAccountBuzzTransaction.mock.calls.length +
  refundMultiAccountTransaction.mock.calls.length;

// All three, or `moneyMoved()` still counts the holds and the assertion measures
// the wrong thing.
const clearMoneyMocks = () => {
  createBuzzTransaction.mockClear();
  createMultiAccountBuzzTransaction.mockClear();
  refundMultiAccountTransaction.mockClear();
};

beforeEach(() => {
  vi.clearAllMocks();
  db.placements.clear();
  db.legs.clear();
  heldLocks.clear();
  configState.rate = 0.3;
  configState.shares = { seller: 0, platform: 0.3 };
  createMultiAccountBuzzTransaction.mockResolvedValue({ transactionCount: 2, totalAmount: 0 });
  createBuzzTransaction.mockResolvedValue({ transactionId: 'buzz-tx' });
  refundMultiAccountTransaction.mockResolvedValue({ externalTransactionIdPrefix: 'refund-tx' });
});

describe('holding the escrow', () => {
  it('takes two holds so every release is a whole-hold operation', async () => {
    givenPlacement();
    const held = await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    expect(held).toEqual({ fee: 300, principal: 700 });
    expect(legsFor(1)).toEqual({ holdFee: 300, holdPrincipal: 700 });
    expect(held.fee + held.principal).toBe(1000);
  });

  // Filtering is a list operation and refusing is not. The mutation names the
  // paid-Buzz set; nothing relies on a picker having hidden the option.
  it('draws from paid Buzz only', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    for (const call of createMultiAccountBuzzTransaction.mock.calls) {
      expect(call[0].fromAccountTypes).toEqual(PLACEMENT_SPEND_TYPES);
      expect(call[0].fromAccountTypes).not.toContain('blue');
      expect(call[0].toAccountId).toBe(0);
    }
  });

  it('uses row-derived external ids, so a retry cannot mint a fresh one', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    const prefixes = createMultiAccountBuzzTransaction.mock.calls.map(
      (c) => c[0].externalTransactionIdPrefix
    );
    expect(prefixes).toEqual(['placement-1-holdFee', 'placement-1-holdPrincipal']);
  });

  it('is a no-op when run twice', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createMultiAccountBuzzTransaction.mockClear();

    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(legsFor(1)).toEqual({ holdFee: 300, holdPrincipal: 700 });
  });

  it('refuses an amount that is not a whole number of Buzz', async () => {
    givenPlacement();
    await expect(
      holdPlacementEscrow({ placementId: 1, placerId: PLACER, surface: 'sticker', amount: 10.5 })
    ).rejects.toThrow(/non-negative integer/);
    expect(moneyMoved()).toBe(0);
  });
});

describe('settling', () => {
  const hold = () =>
    holdPlacementEscrow({ placementId: 1, placerId: PLACER, surface: 'sticker', amount: 1000 });

  it('pays the owner and keeps the platform share on approval', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    const payouts = createBuzzTransaction.mock.calls.map((c) => [c[0].toAccountId, c[0].amount]);
    // Defaults: owner 70%, platform 30%, seller 0.
    expect(payouts).toEqual([[OWNER, 700]]);
    expect(legsFor(1)).toMatchObject({ toOwner: 700, toPlatform: 300 });
  });

  it('pays the fee to the owner and returns the principal hold on decline', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER });

    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ toAccountId: OWNER, amount: 300 })
    );
    // The placer's money returns through a refund of a real hold, so the Buzz
    // service restores the mix it drew from rather than us reconstructing it.
    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'placement-1-holdPrincipal' })
    );
    expect(legsFor(1)).toMatchObject({ feeToOwner: 300, principalToPlacer: 700 });
  });

  it('returns both holds on expiry, so an unanswered placement costs nothing', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'expire' });

    const refunded = refundMultiAccountTransaction.mock.calls.map(
      (c) => c[0].externalTransactionIdPrefix
    );
    expect(refunded).toEqual(['placement-1-holdPrincipal', 'placement-1-holdFee']);
    expect(createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('returns both holds when an owner removes an auto-approved placement', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'removeByOwner', actorId: OWNER });

    // The owner keeps nothing: a fee here would reward accepting placements,
    // banking the money, then sweeping them off.
    expect(createBuzzTransaction).not.toHaveBeenCalled();
    expect(legsFor(1)).toMatchObject({ principalToPlacer: 700, feeToPlacer: 300 });
  });

  it('forfeits a moderator removal without paying the owner', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'removeByModerator', actorId: 999 });

    expect(createBuzzTransaction).not.toHaveBeenCalled();
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(legsFor(1)).toMatchObject({ forfeit: 1000 });
  });

  it('records who removed a placement, so the two removals stay distinguishable', async () => {
    givenPlacement();
    await hold();
    await settlePlacement({ placementId: 1, action: 'removeByModerator', actorId: 999 });

    expect(db.placements.get(1)).toMatchObject({ status: 'removed', removedBy: 'moderator' });
  });
});

describe('running a release path twice', () => {
  const hold = () =>
    holdPlacementEscrow({ placementId: 1, placerId: PLACER, surface: 'sticker', amount: 1000 });

  it.each(['approve', 'decline', 'expire', 'removeByOwner', 'removeByModerator'] as const)(
    'moves no money the second time: %s',
    async (action) => {
      givenPlacement();
      await hold();
      await settlePlacement({ placementId: 1, action, actorId: OWNER });

      const legsAfterFirst = legsFor(1);
      clearMoneyMocks();

      const second = await settlePlacement({
        placementId: 1,
        action,
        actorId: OWNER,
        sellerId: SELLER,
      });

      expect(second.settled).toBe(false);
      expect(moneyMoved()).toBe(0);
      expect(legsFor(1)).toEqual(legsAfterFirst);
    }
  );

  // A block landing while an approval is in flight, or the expiry sweep firing
  // during a decline: the status transition is the lock, so the loser matches no
  // rows and pays nothing.
  it('lets only one of two competing outcomes settle', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });
    clearMoneyMocks();

    const loser = await settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER });

    expect(loser.settled).toBe(false);
    expect(moneyMoved()).toBe(0);
    expect(db.placements.get(1)).toMatchObject({ status: 'approved' });
  });
});

describe('crashing between the legs', () => {
  const hold = () =>
    holdPlacementEscrow({ placementId: 1, placerId: PLACER, surface: 'sticker', amount: 1000 });

  // The case the ledger exists for. A status column says the placement was
  // processed; only a receipt says the money moved.
  it('resumes a decline that paid the fee and died before refunding', async () => {
    givenPlacement();
    await hold();
    refundMultiAccountTransaction.mockRejectedValueOnce(new Error('buzz service down'));

    await expect(
      settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER })
    ).rejects.toThrow('buzz service down');

    // Settled, owner paid, placer still owed — and it is queryable, not a log line.
    expect(db.placements.get(1)).toMatchObject({ status: 'declined' });
    expect(db.legs.get('1:feeToOwner')?.transactionId).toBe('buzz-tx');
    expect(db.legs.get('1:principalToPlacer')?.transactionId).toBeNull();

    createBuzzTransaction.mockClear();
    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(swept.resumed).toBe(1);
    // The finished leg is not paid again...
    expect(createBuzzTransaction).not.toHaveBeenCalled();
    // ...and the stranded one completes.
    expect(db.legs.get('1:principalToPlacer')?.transactionId).toBe('refund-tx');
  });

  it('does not re-run a leg whose payment already landed', async () => {
    givenPlacement();
    await hold();
    await settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER });

    clearMoneyMocks();

    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(swept.stranded).toBe(0);
    expect(moneyMoved()).toBe(0);
  });

  it('leaves a still-pending placement alone', async () => {
    givenPlacement();
    await hold();

    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(swept.resumed).toBe(0);
    expect(db.placements.get(1)).toMatchObject({ status: 'pending' });
  });
});

describe('expiry sweep', () => {
  it('settles only placements past their deadline, in a bounded batch', async () => {
    givenPlacement({ id: 1, expiresAt: new Date(Date.now() - 1000) });
    givenPlacement({ id: 2, expiresAt: new Date(Date.now() + 60_000) });
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    const result = await expirePlacements({ limit: 50 });

    expect(result.expired).toBe(1);
    expect(db.placements.get(1)).toMatchObject({ status: 'expired' });
    expect(db.placements.get(2)).toMatchObject({ status: 'pending' });
  });

  it('is a no-op on a second run', async () => {
    givenPlacement({ id: 1, expiresAt: new Date(Date.now() - 1000) });
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    await expirePlacements();

    refundMultiAccountTransaction.mockClear();
    const second = await expirePlacements();

    expect(second.expired).toBe(0);
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });
});

describe('the amounts a resume replays', () => {
  const hold = () =>
    holdPlacementEscrow({ placementId: 1, placerId: PLACER, surface: 'sticker', amount: 1000 });

  // The holds are sized by the config as it stood when the placement was made.
  // Recomputing the fee at decline time paid out more than was ever held — a
  // rate change alone minted the difference, with no crash and no race.
  it('pays the fee that was held, not the fee the config now says', async () => {
    storedRate(0.05);
    givenPlacement();
    await hold();
    expect(legsFor(1)).toEqual({ holdFee: 50, holdPrincipal: 950 });

    storedRate(0.5);
    await settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER });

    const paidOut = Object.entries(legsFor(1))
      .filter(([kind]) => !kind.startsWith('hold'))
      .reduce((sum, [, amount]) => sum + amount, 0);

    expect(legsFor(1)).toMatchObject({ feeToOwner: 50, principalToPlacer: 950 });
    expect(paidOut).toBe(1000);
    expect(createBuzzTransaction).toHaveBeenCalledWith(expect.objectContaining({ amount: 50 }));
  });

  // Same defect reached by crash-then-resume: the legs that hadn't run yet were
  // paid against a split recomputed from the new config.
  it('replays the original split when the shares move mid-payout', async () => {
    givenPlacement({ sellerId: SELLER });
    await hold();
    storedShares({ seller: 0.05, platform: 0.05 });
    createBuzzTransaction.mockRejectedValueOnce(new Error('buzz service down'));

    await expect(
      settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER })
    ).rejects.toThrow('buzz service down');

    storedShares({ seller: 0.45, platform: 0.05 });
    await sweepUnpaidLegs({ olderThanMinutes: 0 });

    const planned = legsFor(1);
    const paidOut = planned.toOwner + planned.toSeller + (planned.toPlatform ?? 0);
    expect(paidOut).toBe(1000);
    expect(planned.toOwner).toBe(900);
  });

  it('keeps the ledger summing to what was held, on every outcome', async () => {
    for (const action of [
      'approve',
      'decline',
      'expire',
      'removeByOwner',
      'removeByModerator',
    ] as const) {
      db.placements.clear();
      db.legs.clear();
      givenPlacement({ sellerId: SELLER });
      await hold();
      await settlePlacement({ placementId: 1, action, actorId: OWNER });

      const legs = legsFor(1);
      const held = legs.holdFee + legs.holdPrincipal;
      const out = Object.entries(legs)
        .filter(([kind]) => !kind.startsWith('hold'))
        .reduce((sum, [, amount]) => sum + amount, 0);

      expect(out, `${action} paid out ${out} of ${held}`).toBe(held);
    }
  });
});

describe('the seller share survives a resume', () => {
  // sellerId was a call-time argument to a resumable operation. The sweeper never
  // saw it, folded the seller's share into the platform keep, and left no record
  // that anyone was owed.
  it('pays the seller from the row when the sweeper finishes the payout', async () => {
    givenPlacement({ sellerId: SELLER });
    storedShares({ seller: 0.3, platform: 0.3 });
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createBuzzTransaction.mockRejectedValueOnce(new Error('buzz service down'));

    await expect(
      settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER })
    ).rejects.toThrow('buzz service down');

    clearMoneyMocks();
    await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ toAccountId: SELLER })
    );
    expect(legsFor(1).toSeller).toBeGreaterThan(0);
  });
});

describe('two callers on one leg', () => {
  // The unique constraint serialises the CLAIM. Without a lock, a second caller
  // finds a claimed row with no receipt yet and pays anyway, leaving the remote's
  // dedupe as the only thing between that and a double payment.
  it('does not let both reach the Buzz call', async () => {
    givenPlacement();
    let release: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => (release = resolve));
    createMultiAccountBuzzTransaction.mockImplementationOnce(async () => {
      await inFlight;
      return { transactionCount: 2, totalAmount: 0 };
    });

    const first = holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    await Promise.resolve();
    const second = holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    release();
    await Promise.all([first, second]);

    const feeCalls = createMultiAccountBuzzTransaction.mock.calls.filter(
      (c) => c[0].externalTransactionIdPrefix === 'placement-1-holdFee'
    );
    expect(feeCalls).toHaveLength(1);
  });
});

describe('the expiry deadline', () => {
  // A null expiresAt is never `<= now()`, so the sweep steps over it forever and
  // the escrow is frozen — the exact failure expiry exists to prevent.
  it('is set when the escrow is taken', async () => {
    givenPlacement({ expiresAt: null });
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    expect(db.placements.get(1)?.expiresAt).toBeInstanceOf(Date);
  });
});
