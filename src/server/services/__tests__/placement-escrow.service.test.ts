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
const lockState = { available: true };
vi.mock('~/server/utils/distributed-lock', () => ({
  withDistributedLock: async (options: { key: string }, operation: () => Promise<unknown>) => {
    // Redis down, or the key contended past maxRetries: the real helper returns
    // null WITHOUT running the operation.
    if (!lockState.available) return null;
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
      attempts: number;
      lastAttemptAt?: Date | null;
      lastError?: string | null;
      createdAt: Date;
    }
  >(),
};

type LedgerQuery = {
  where: Record<
    string,
    { in?: string[]; not?: string | null; lt?: Date } | number | null | undefined
  >;
  distinct?: string[];
  take?: number;
};

const legKey = (placementId: number, kind: string) => `${placementId}:${kind}`;

const dbWriteMock: Record<string, unknown> = {};
const queryRaw = vi.fn(async () => [] as { id: number }[]);
const txCommits: string[][] = [];
vi.mock('~/server/db/client', () => ({
  dbWrite: dbWriteMock,
}));

Object.assign(dbWriteMock, {
  // Interactive transaction: the callback gets the same client. Good enough to
  // exercise "these two writes happen together", which is the property under
  // test; it does NOT model rollback, so a test asserting partial failure would
  // be lying.
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
    const result = await fn(dbWriteMock);
    // Snapshot at commit: the point of the transaction is that the plan is on
    // disk the instant the status is, so a later planPayout cannot be what makes
    // the assertion pass.
    txCommits.push([...db.legs.keys()]);
    return result;
  },
  $queryRaw: queryRaw,
  ...{
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
          const row = { ...data, transactionId: null, attempts: 0, createdAt: new Date(0) };
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
          if (where.attempts?.lt !== undefined && leg.attempts >= where.attempts.lt) return false;
          if (where.attempts?.gte !== undefined && leg.attempts < where.attempts.gte) return false;
          if (where.lastAttemptAt?.gt !== undefined) {
            if (!leg.lastAttemptAt || leg.lastAttemptAt <= where.lastAttemptAt.gt) return false;
          }
          if (Array.isArray((where as Record<string, unknown>).OR)) {
            const clauses = (where as unknown as { OR: { lastAttemptAt: null | { lt: Date } }[] })
              .OR;
            const ok = clauses.some((clause) =>
              clause.lastAttemptAt === null
                ? leg.lastAttemptAt == null
                : !!leg.lastAttemptAt && leg.lastAttemptAt < clause.lastAttemptAt.lt
            );
            if (!ok) return false;
          }
          if (where.amount?.gt !== undefined && leg.amount <= where.amount.gt) return false;
          if (where.transactionId === null && leg.transactionId !== null) return false;
          // `{ not: null }` means receipted-only. Ignoring it would let a
          // claimed-but-unpaid hold count as money in escrow, which is the
          // defect this predicate exists to prevent.
          if (
            where.transactionId &&
            typeof where.transactionId === 'object' &&
            'not' in where.transactionId &&
            where.transactionId.not === null &&
            leg.transactionId === null
          )
            return false;
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
      count: vi.fn(async ({ where }: LedgerQuery) => {
        return [...db.legs.values()].filter((leg) => {
          if (where.placementId !== undefined && leg.placementId !== where.placementId)
            return false;
          if (where.kind?.in && !where.kind.in.includes(leg.kind)) return false;
          if (where.transactionId === null && leg.transactionId !== null) return false;
          if (where.attempts?.gte !== undefined && leg.attempts < where.attempts.gte) return false;
          if (where.amount?.gt !== undefined && leg.amount <= where.amount.gt) return false;
          return true;
        }).length;
      }),
      createMany: vi.fn(
        async ({ data }: { data: { placementId: number; kind: string; amount: number }[] }) => {
          for (const row of data) {
            const key = legKey(row.placementId, row.kind);
            if (!db.legs.has(key))
              db.legs.set(key, {
                ...row,
                transactionId: null,
                attempts: 0,
                createdAt: new Date(0),
              });
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
          data: {
            transactionId?: string | null;
            lastError?: string | null;
            attempts?: { increment: number };
            lastAttemptAt?: Date;
          };
        }) => {
          const row = db.legs.get(
            legKey(where.placementId_kind.placementId, where.placementId_kind.kind)
          );
          if (row) {
            if (
              data.attempts &&
              typeof data.attempts === 'object' &&
              'increment' in data.attempts
            ) {
              row.attempts += data.attempts.increment;
              row.lastAttemptAt = new Date();
            }
            if ('transactionId' in data) row.transactionId = data.transactionId ?? null;
            if ('lastError' in data) row.lastError = data.lastError ?? null;
          }
          return row;
        }
      ),
    },
  },
});

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

const {
  holdPlacementEscrow,
  settlePlacement,
  expirePlacements,
  sweepUnpaidLegs,
  sweepUnplannedSettlements,
  MAX_LEG_ATTEMPTS,
  LEG_RETRY_BACKOFF_MINUTES,
  BUZZ_CALL_TIMEOUT_MS,
  listExhaustedLegs,
} = await import('~/server/services/placement-escrow.service');

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

/**
 * Moves every attempted leg of a placement outside the retry gap, standing in
 * for elapsed time.
 *
 * Per-*placement*, not per-leg, because the sweep selects placements and
 * `payOutPlacement` re-runs all of their legs — ageing one and asserting on it
 * would let a sibling stay silently stranded inside its own backoff, which is
 * the same list-vs-guard mismatch that has bitten the production code twice.
 *
 * Throws on a miss rather than no-opping: a helper that silently does nothing
 * lets a test asserting a negative pass without the setup it claims.
 */
const ageLastAttempt = (placementId: number) => {
  const legs = [...db.legs.values()].filter(
    (leg) => leg.placementId === placementId && leg.lastAttemptAt
  );
  if (!legs.length)
    throw new Error(`ageLastAttempt: placement ${placementId} has no attempted legs to age`);

  for (const leg of legs)
    leg.lastAttemptAt = new Date(Date.now() - (LEG_RETRY_BACKOFF_MINUTES + 1) * 60_000);
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
  queryRaw.mockResolvedValue([]);
  txCommits.length = 0;
  lockState.available = true;
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
      expect.objectContaining({ toAccountId: OWNER, amount: 300 }),
      expect.anything()
    );
    // The placer's money returns through a refund of a real hold, so the Buzz
    // service restores the mix it drew from rather than us reconstructing it.
    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'placement-1-holdPrincipal' }),
      expect.anything()
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
    // The refund leg recorded a failed attempt, so it waits out the retry gap
    // before being tried again — that is what stops a transient outage burning
    // the whole budget in minutes.
    const refundLeg = db.legs.get('1:principalToPlacer');
    if (refundLeg)
      refundLeg.lastAttemptAt = new Date(Date.now() - (LEG_RETRY_BACKOFF_MINUTES + 1) * 60_000);

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
    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50 }),
      expect.anything()
    );
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
      expect.objectContaining({ toAccountId: SELLER }),
      expect.anything()
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
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);

    const feeCalls = createMultiAccountBuzzTransaction.mock.calls.filter(
      (c) => c[0].externalTransactionIdPrefix === 'placement-1-holdFee'
    );
    expect(feeCalls).toHaveLength(1);
    // The loser fails rather than reporting an escrow it did not take — its
    // caller must not go on to create a placement backed by nothing.
    expect(firstResult.status).toBe('fulfilled');
    expect(secondResult.status).toBe('rejected');
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

describe('when the lock cannot be acquired', () => {
  // `withDistributedLock` returns null without running when Redis is unavailable.
  // If the ledger claim lived inside the lock, that would leave no row at all:
  // the placement reads settled, nobody is paid, and the sweeper has nothing to
  // find. Claiming outside it makes the worst case a receipt-less row.
  it('still records the claim, so the sweeper can finish it', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    lockState.available = false;

    await settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER });

    expect(createBuzzTransaction).not.toHaveBeenCalled();
    expect(legsFor(1)).toMatchObject({ feeToOwner: 300, principalToPlacer: 700 });
    expect(db.legs.get('1:feeToOwner')?.transactionId).toBeNull();

    lockState.available = true;
    await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(db.legs.get('1:feeToOwner')?.transactionId).toBe('buzz-tx');
    expect(db.legs.get('1:principalToPlacer')?.transactionId).toBe('refund-tx');
  });

  // The caller must not be told the escrow is held when nothing was charged: it
  // would create the placement, and approving it later would pay out of an
  // account that never received the money. Hold legs cannot be swept either —
  // the sweeper skips pending placements, and a hold only exists while one is.
  it('refuses to report a hold it could not take', async () => {
    givenPlacement();
    lockState.available = false;

    await expect(
      holdPlacementEscrow({ placementId: 1, placerId: PLACER, surface: 'sticker', amount: 1000 })
    ).rejects.toThrow(/nothing was charged/);

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('does not take the escrow twice when the hold is retried after a lock failure', async () => {
    givenPlacement();
    lockState.available = false;
    await expect(
      holdPlacementEscrow({ placementId: 1, placerId: PLACER, surface: 'sticker', amount: 1000 })
    ).rejects.toThrow();

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(legsFor(1)).toEqual({ holdFee: 300, holdPrincipal: 700 });

    lockState.available = true;
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(2);
    expect(legsFor(1)).toEqual({ holdFee: 300, holdPrincipal: 700 });
  });
});

describe('the sweeper converges', () => {
  // A leg with nothing to pay can never acquire a receipt, so persisting one
  // leaves it in the sweeper's result set forever. Past `take: limit` those
  // rows crowd out genuinely stranded legs, and the recovery path starves while
  // reporting success every run.
  it('does not persist a leg that moves no money', async () => {
    givenPlacement({ sellerId: null });
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(legsFor(1)).not.toHaveProperty('toSeller');
  });

  it('reports nothing stranded once a placement is fully paid', async () => {
    givenPlacement({ sellerId: null });
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    const first = await sweepUnpaidLegs({ olderThanMinutes: 0 });
    const second = await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(first.stranded).toBe(0);
    expect(second.stranded).toBe(0);
  });

  // The batch is bounded, so a permanently-unclearable row is not merely waste:
  // enough of them and a genuinely stranded leg never makes it into a run.
  it('still finds a stranded leg when other placements are settled', async () => {
    for (const id of [1, 2, 3]) {
      givenPlacement({ id, sellerId: null });
      await holdPlacementEscrow({
        placementId: id,
        placerId: PLACER,
        surface: 'sticker',
        amount: 1000,
      });
      await settlePlacement({ placementId: id, action: 'approve', actorId: OWNER });
    }

    givenPlacement({ id: 4, sellerId: null });
    await holdPlacementEscrow({
      placementId: 4,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createBuzzTransaction.mockRejectedValueOnce(new Error('buzz service down'));
    await expect(
      settlePlacement({ placementId: 4, action: 'approve', actorId: OWNER })
    ).rejects.toThrow();

    ageLastAttempt(4);
    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0, limit: 1 });

    expect(swept.stranded).toBe(1);
    expect(db.legs.get('4:toOwner')?.transactionId).toBe('buzz-tx');
  });
});

describe('when two callers claim different amounts', () => {
  // Two callers read live config at slightly different moments, so they can
  // compute different numbers for the same leg. Whoever loses the insert must
  // pay what the ledger records, not its own copy — otherwise the escrow moves
  // an amount reconciliation cannot see.
  // The payout path is covered by the plan being re-read from the ledger. The
  // hold path is not: its amounts are computed locally from live config on every
  // call, so a caller that loses the insert across a rate change would otherwise
  // charge a number the ledger does not record.
  it('charges the held amount the winning claim recorded, not its own', async () => {
    givenPlacement();
    // A concurrent hold got there first, at the rate as it stood then.
    db.legs.set('1:holdFee', {
      placementId: 1,
      kind: 'holdFee',
      amount: 200,
      transactionId: null,
      createdAt: new Date(0),
    });

    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    const feeCall = createMultiAccountBuzzTransaction.mock.calls.find(
      (c) => c[0].externalTransactionIdPrefix === 'placement-1-holdFee'
    );
    expect(feeCall?.[0].amount).toBe(200);
    expect(legsFor(1).holdFee).toBe(200);
  });

  it('pays the payout amounts the ledger holds, not a freshly computed plan', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    db.legs.set('1:toOwner', {
      placementId: 1,
      kind: 'toOwner',
      amount: 400,
      transactionId: null,
      createdAt: new Date(0),
    });

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 400 }),
      expect.anything()
    );
    expect(createBuzzTransaction).not.toHaveBeenCalledWith(
      expect.objectContaining({ amount: 700 }),
      expect.anything()
    );
  });
});

describe('a settlement always leaves a plan', () => {
  // The status flip and the plan are one transaction. Two statements would let a
  // crash between them leave a placement approved and live with no plan — a
  // state nothing recovers, since it is not pending (expiry skips it) and has no
  // claimed-but-unpaid leg (the sweeper skips it).
  it('writes the payout plan in the same breath as the status', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createBuzzTransaction.mockRejectedValue(new Error('buzz service down'));

    await expect(
      settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER })
    ).rejects.toThrow();

    expect(db.placements.get(1)).toMatchObject({ status: 'approved' });
    // The plan is on disk at the moment the status commits — not written later
    // by the payout, which is what leaves the unrecoverable gap.
    const atCommit = txCommits.at(-1) ?? [];
    expect(atCommit).toContain('1:toOwner');
    expect(atCommit).toContain('1:toPlatform');
  });

  // The dangerous case is money never paid, not money already paid: a takedown
  // flips an approved placement to removed, and if no plan existed yet the first
  // thing to compute one would forfeit the owner's earnings to the platform.
  it('does not let a later takedown forfeit what the owner had earned', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createBuzzTransaction.mockRejectedValueOnce(new Error('buzz service down'));

    await expect(
      settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER })
    ).rejects.toThrow();

    // A moderator takes it down before the payout was finished.
    const placement = db.placements.get(1) as Record<string, unknown>;
    placement.status = 'removed';
    placement.removedBy = 'moderator';

    await sweepUnpaidLegs({ olderThanMinutes: 0 });

    // The plan written at approval still governs: the owner is paid, and no
    // forfeit leg appears.
    expect(legsFor(1)).toMatchObject({ toOwner: 700 });
    expect(legsFor(1)).not.toHaveProperty('forfeit');
    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ toAccountId: OWNER, amount: 700 }),
      expect.anything()
    );
  });
});

describe('an unfunded placement', () => {
  // The trap: asserting "no payout happens" passes for the wrong reason if the
  // hold legs are simply absent. The case that bites is a hold leg PRESENT with
  // a null transactionId — claimed but never charged — which is exactly what a
  // Redis outage leaves behind.
  const givenClaimedButUnpaidHolds = () => {
    db.legs.set('1:holdFee', {
      placementId: 1,
      kind: 'holdFee',
      amount: 300,
      transactionId: null,
      createdAt: new Date(0),
    });
    db.legs.set('1:holdPrincipal', {
      placementId: 1,
      kind: 'holdPrincipal',
      amount: 700,
      transactionId: null,
      createdAt: new Date(0),
    });
  };

  it('pays nothing out, because that Buzz was never taken', async () => {
    givenPlacement();
    givenClaimedButUnpaidHolds();

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(createBuzzTransaction).not.toHaveBeenCalled();
    expect(legsFor(1)).toEqual({ holdFee: 300, holdPrincipal: 700 });
  });

  it('refunds nothing on decline either', async () => {
    givenPlacement();
    givenClaimedButUnpaidHolds();

    await settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER });

    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
    expect(createBuzzTransaction).not.toHaveBeenCalled();
  });

  it('is surfaced by the unplanned-settlement sweep rather than disappearing', async () => {
    givenPlacement();
    givenClaimedButUnpaidHolds();
    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    // The placement settled with no payout legs, which is the state the second
    // sweep exists to find.
    expect(legsFor(1)).not.toHaveProperty('toOwner');
  });
});

describe('the unpaid-leg sweep only covers legs it can finish', () => {
  // Hold legs also match "claimed but unpaid", and this sweep can never finish
  // one: it skips pending placements, and nothing writes a hold receipt after a
  // settle. They would sit in the batch forever and starve it.
  it('never returns a pending placement whose hold was claimed but not charged', async () => {
    givenPlacement();
    db.legs.set('1:holdFee', {
      placementId: 1,
      kind: 'holdFee',
      amount: 300,
      transactionId: null,
      createdAt: new Date(0),
    });

    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(swept.stranded).toBe(0);
  });

  it('still finds a genuinely stranded payout leg alongside one', async () => {
    givenPlacement({ id: 1 });
    db.legs.set('1:holdFee', {
      placementId: 1,
      kind: 'holdFee',
      amount: 300,
      transactionId: null,
      createdAt: new Date(0),
    });

    givenPlacement({ id: 2 });
    await holdPlacementEscrow({
      placementId: 2,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createBuzzTransaction.mockRejectedValueOnce(new Error('buzz service down'));
    await expect(
      settlePlacement({ placementId: 2, action: 'approve', actorId: OWNER })
    ).rejects.toThrow();

    ageLastAttempt(2);
    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0, limit: 1 });

    expect(swept.stranded).toBe(1);
    expect(db.legs.get('2:toOwner')?.transactionId).toBe('buzz-tx');
  });
});

describe('a leg that can never succeed', () => {
  // The recurring defect: a row the sweep finds and can never finish consumes a
  // slot in every bounded batch. Three instances were fixed by narrowing a query;
  // this is the general answer, so the fourth is reported rather than silent.
  const givenPermanentlyFailingLeg = async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createBuzzTransaction.mockRejectedValue(new Error('unknown account'));
    await expect(
      settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER })
    ).rejects.toThrow();
  };

  it('counts its attempts and records why it failed', async () => {
    await givenPermanentlyFailingLeg();

    expect(db.legs.get('1:toOwner')?.attempts).toBe(1);
    expect(db.legs.get('1:toOwner')?.lastError).toContain('unknown account');
  });

  it('stops being retried once it exhausts them', async () => {
    await givenPermanentlyFailingLeg();

    for (let i = 0; i < MAX_LEG_ATTEMPTS + 2; i++) {
      const leg = db.legs.get('1:toOwner');
      if (leg) leg.lastAttemptAt = null;
      await sweepUnpaidLegs({ olderThanMinutes: 0 }).catch(() => null);
    }

    const leg = db.legs.get('1:toOwner');
    expect(leg?.attempts).toBeLessThanOrEqual(MAX_LEG_ATTEMPTS);

    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0 });
    expect(swept.stranded).toBe(0);
  });

  // Not retrying is only half of it. Silently dropping the row would turn a
  // starving batch into an invisible one.
  it('is reported once it stops being retried', async () => {
    await givenPermanentlyFailingLeg();
    // Ages rather than clears, so the leg still carries a recent attempt when the
    // ceiling stops it — which is what the alert window keys on.
    for (let i = 0; i < MAX_LEG_ATTEMPTS + 2; i++) {
      ageLastAttempt(1);
      await sweepUnpaidLegs({ olderThanMinutes: 0 }).catch(() => null);
    }

    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(swept.exhausted).toBeGreaterThan(0);
  });

  it('clears its error when a later attempt succeeds', async () => {
    await givenPermanentlyFailingLeg();
    createBuzzTransaction.mockResolvedValue({ transactionId: 'buzz-tx' });
    ageLastAttempt(1);

    await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(db.legs.get('1:toOwner')?.transactionId).toBe('buzz-tx');
    expect(db.legs.get('1:toOwner')?.lastError).toBeNull();
  });
});

describe('a settlement with no funded escrow behind it', () => {
  // It plans nothing, so the sweep would otherwise count it as resumed on every
  // run forever — the same false-healthy signal as a counter that measures work
  // attempted rather than work landed. It is terminal, not resumable.
  it('is reported as unfunded rather than counted as resumed', async () => {
    givenPlacement({ status: 'approved', resolvedAt: new Date(0) });
    db.legs.set('1:holdFee', {
      placementId: 1,
      kind: 'holdFee',
      amount: 300,
      transactionId: null,
      attempts: 0,
      createdAt: new Date(0),
    });
    queryRaw.mockResolvedValue([{ id: 1 }]);

    const swept = await sweepUnplannedSettlements({ olderThanMinutes: 0 });

    expect(swept).toMatchObject({ unplanned: 1, planned: 0, unfunded: 1 });
  });

  it('counts a genuinely resumable settlement as planned', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    db.placements.get(1)!.status = 'approved';
    db.placements.get(1)!.resolvedAt = new Date(0);
    queryRaw.mockResolvedValue([{ id: 1 }]);

    const swept = await sweepUnplannedSettlements({ olderThanMinutes: 0 });

    expect(swept).toMatchObject({ planned: 1, unfunded: 0 });
  });
});

describe('the retry budget measures elapsed failure, not sweep frequency', () => {
  // Without a gap between attempts the ceiling is a function of how often the
  // cron runs: a ten-minute schedule would burn all five inside an hour, so a
  // transient outage would permanently strand a leg that only needed waiting out.
  it('skips a leg attempted too recently', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createBuzzTransaction.mockRejectedValueOnce(new Error('buzz service down'));
    await expect(
      settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER })
    ).rejects.toThrow();

    createBuzzTransaction.mockClear();
    await sweepUnpaidLegs({ olderThanMinutes: 0 });

    // Untried legs on the same placement are still eligible; the one that just
    // failed is not tried again until the gap has passed.
    expect(db.legs.get('1:toOwner')?.attempts).toBe(1);
    expect(createBuzzTransaction).not.toHaveBeenCalledWith(
      expect.objectContaining({ toAccountId: OWNER })
    );
  });

  it('retries once the gap has passed', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createBuzzTransaction.mockRejectedValueOnce(new Error('buzz service down'));
    await expect(
      settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER })
    ).rejects.toThrow();

    const leg = db.legs.get('1:toOwner');
    if (leg) leg.lastAttemptAt = new Date(Date.now() - (LEG_RETRY_BACKOFF_MINUTES + 1) * 60_000);

    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(swept.stranded).toBe(1);
    expect(db.legs.get('1:toOwner')?.transactionId).toBe('buzz-tx');
  });
});

describe('the exhausted-leg alert', () => {
  const exhaustLeg = async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createBuzzTransaction.mockRejectedValue(new Error('unknown account'));
    await expect(
      settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER })
    ).rejects.toThrow();

    for (let i = 0; i < MAX_LEG_ATTEMPTS + 2; i++) {
      ageLastAttempt(1);
      await sweepUnpaidLegs({ olderThanMinutes: 0 }).catch(() => null);
    }
  };

  // The outstanding count is a gauge, not a windowed error log. An exhausted leg
  // stops being touched, so its `lastAttemptAt` freezes — any window over that
  // timestamp reports for a while and then goes permanently silent with the money
  // still parked. "Something just broke" is the one-shot error on the transition;
  // "something is still broken" has to keep being true.
  it('keeps counting an exhausted leg however long ago it gave up', async () => {
    await exhaustLeg();

    const leg = db.legs.get('1:toOwner');
    if (leg) leg.lastAttemptAt = new Date(Date.now() - 30 * 24 * 60 * 60_000);

    const swept = await sweepUnpaidLegs({ olderThanMinutes: 0 });

    expect(swept.exhausted).toBe(1);
  });

  // ...but the leg is still findable by someone looking for it deliberately.
  it('leaves the leg discoverable after the alert has gone quiet', async () => {
    await exhaustLeg();

    const legs = await listExhaustedLegs();

    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ placementId: 1, kind: 'toOwner', amount: 700 });
    expect(legs[0].lastError).toContain('unknown account');
  });
});

describe('the Buzz call bound', () => {
  // An aborted request is not cancelled server-side, so retrying a timeout puts
  // a second write on the wire with the same external id while the first may
  // still be running. runLeg owns the retry; the client's must stay out of it.
  it('disables the client retry on every write', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    await settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER });

    const calls = [
      ...createMultiAccountBuzzTransaction.mock.calls,
      ...createBuzzTransaction.mock.calls,
      ...refundMultiAccountTransaction.mock.calls,
    ];

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call[1]).toMatchObject({ retries: 0 });
  });

  it('bounds every write, and inside the retry gap', () => {
    expect(BUZZ_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    // The whole point of deriving it: the request must be over well before the
    // leg becomes eligible again.
    expect(BUZZ_CALL_TIMEOUT_MS).toBeLessThan(LEG_RETRY_BACKOFF_MINUTES * 60_000);
  });

  // "Make retries less aggressive" reaches for a bigger gap and "recover faster"
  // for a smaller one; unclamped, both produce a timeout that cannot work.
  it('stays usable at the extremes of the gap it derives from', () => {
    expect(BUZZ_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(BUZZ_CALL_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });
});
