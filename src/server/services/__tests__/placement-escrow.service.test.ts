import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PLACEMENT_HOLD_KINDS } from '~/shared/utils/placement';
// Mocked below; imported for the assertion that a swallowed reward failure is
// still reported.
import { logToAxiom } from '~/server/logging/client';
// Stubbed globally in src/__tests__/setup.ts.
import { placementUnfundedSettlementsGauge } from '~/server/prom/client';

const createMultiAccountBuzzTransaction = vi.fn();
const refundMultiAccountTransaction = vi.fn();
const createBuzzTransaction = vi.fn();

vi.mock('~/server/services/buzz.service', () => ({
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
  createBuzzTransaction,
}));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn().mockResolvedValue(undefined) }));

// Wholesale on purpose: the real module loads `base.reward`, which builds a
// ClickHouse client, redis handles and prom collectors at import time. The
// reward's own behaviour is tested in stickerPlacementAccepted.reward.test.ts;
// what this suite owns is WHEN settlement hands it a placement.
const applyAcceptReward = vi.fn();
vi.mock('~/server/rewards/active/stickerPlacementAccepted.reward', () => ({
  stickerPlacementAcceptedReward: { apply: applyAcceptReward },
}));

// The remix reward, which this service must NEVER grant — it is granted from
// `actOnRemixGallerySubmission`, the only path by which a remix submission is
// approved. Mocked here so the exclusivity test below observes the real shared
// chokepoint: this suite is the only place that exercises it, since the remix
// suite mocks `settlePlacement` wholesale and cannot see what it fires.
const applyRemixReward = vi.fn();
vi.mock('~/server/rewards/active/remixAccept.reward', () => ({
  remixAcceptReward: { apply: applyRemixReward },
}));

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
      // Projects `select` rather than handing back the whole row. A double that
      // ignores it answers with columns the query never asked for, so narrowing
      // a select in the code under test changes nothing here and the revert is
      // invisible.
      findUnique: vi.fn(
        async ({ where, select }: { where: { id: number }; select?: Record<string, boolean> }) => {
          const row = db.placements.get(where.id);
          if (!row) return null;
          if (!select) return row;
          return Object.fromEntries(
            Object.keys(select)
              .filter((column) => select[column])
              .map((column) => [column, row[column]])
          );
        }
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
  PAYOUT_KINDS,
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
    // Present and NULL, as the column is on a real row. Omitting it made the
    // double answer `undefined` where Postgres answers NULL, which is a
    // different thing to a `where: { spendType: null }` predicate.
    spendType: null,
    // Present and false, as the column is on a real row. Left off, `free` reads
    // `undefined` here where Postgres answers false — falsy either way today, and
    // a difference the moment anything compares it rather than tests it.
    free: false,
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
  applyAcceptReward.mockResolvedValue(undefined);
  applyRemixReward.mockResolvedValue(undefined);
  // The real response carries the legs it reversed. The double used to return
  // only the prefix, which let a refund that moved NOTHING look identical to one
  // that moved everything — the exact discrepancy the service now refuses on.
  refundMultiAccountTransaction.mockResolvedValue({
    externalTransactionIdPrefix: 'refund-tx',
    refundedTransactions: [
      {
        originalTransactionId: 'orig',
        refundTransactionId: 'refund-tx',
        accountType: 'User',
        amount: 1,
      },
    ],
    totalRefunded: 1,
  });
});

describe('holding the escrow', () => {
  it('takes two holds so every release is a whole-hold operation', async () => {
    givenPlacement();
    const held = await holdPlacementEscrow({
      spendType: 'yellow',
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
      spendType: 'yellow',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    for (const call of createMultiAccountBuzzTransaction.mock.calls) {
      expect(call[0].fromAccountTypes).toEqual(['yellow']);
      expect(call[0].fromAccountTypes).not.toContain('blue');
      expect(call[0].toAccountId).toBe(0);
    }
  });

  // The hold names its destination account. Leaving it unnamed let the buzz
  // service apply its yellow default, which converted a green placement to
  // yellow on the way INTO escrow — so by settlement there was no green left to
  // pay the owner with, whatever the payout leg asked for.
  it('holds green in green, rather than converting it at intake', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      spendType: 'green',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(2);
    for (const call of createMultiAccountBuzzTransaction.mock.calls) {
      expect(call[0].fromAccountTypes).toEqual(['green']);
      expect(call[0].toAccountType).toBe('green');
    }
  });

  // One currency per placement. Two would leave the settlement unable to pay
  // back in kind: a placement funded 40 green and 60 yellow has no single
  // account to release from.
  it('draws from exactly one account, never the pair', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      spendType: 'green',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    for (const call of createMultiAccountBuzzTransaction.mock.calls)
      expect(call[0].fromAccountTypes).toHaveLength(1);
  });

  it('refuses a currency the escrow cannot hold', async () => {
    givenPlacement();

    await expect(
      holdPlacementEscrow({
        spendType: 'blue',
        placementId: 1,
        placerId: PLACER,
        surface: 'sticker',
        amount: 1000,
      })
    ).rejects.toThrow('not a placement spend type');
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  // The currency write rides the `expiresAt: null` stamp, which a second run
  // does not match — but this function is deliberately idempotent, so a row that
  // already has a deadline must still end up carrying its currency. Otherwise
  // the holds charge green against a row that settles yellow.
  it('records the currency even when the deadline was already stamped', async () => {
    const placement = givenPlacement({ expiresAt: new Date('2030-01-01') });

    await holdPlacementEscrow({
      spendType: 'green',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    expect(placement.spendType).toBe('green');
  });

  // The one case that cannot be reconciled: the escrow can hold only one
  // currency, so charging a second one against the same row would strand
  // whichever the settlement does not pay.
  it('refuses to charge a currency the row is not held in', async () => {
    givenPlacement({ expiresAt: new Date('2030-01-01'), spendType: 'yellow' });

    await expect(
      holdPlacementEscrow({
        spendType: 'green',
        placementId: 1,
        placerId: PLACER,
        surface: 'sticker',
        amount: 1000,
      })
    ).rejects.toThrow('refusing to charge green');
    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('records the currency on the row, so a resumed settlement can read it', async () => {
    const placement = givenPlacement();
    await holdPlacementEscrow({
      spendType: 'green',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    expect(placement.spendType).toBe('green');
    // Written by the same statement as the deadline. A row that got one without
    // the other would settle as legacy yellow over an escrow holding green.
    expect(placement.expiresAt).toBeInstanceOf(Date);
  });

  it('uses row-derived external ids, so a retry cannot mint a fresh one', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      spendType: 'yellow',
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
      spendType: 'yellow',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    createMultiAccountBuzzTransaction.mockClear();

    await holdPlacementEscrow({
      spendType: 'yellow',
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
      holdPlacementEscrow({
        spendType: 'yellow',
        placementId: 1,
        placerId: PLACER,
        surface: 'sticker',
        amount: 10.5,
      })
    ).rejects.toThrow(/non-negative integer/);
    expect(moneyMoved()).toBe(0);
  });
});

describe('settling', () => {
  const hold = () =>
    holdPlacementEscrow({
      spendType: 'yellow',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

  it('pays the owner and keeps the platform share on approval', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    const payouts = createBuzzTransaction.mock.calls.map((c) => [c[0].toAccountId, c[0].amount]);
    // Defaults: owner 70%, platform 30%, seller 0.
    expect(payouts).toEqual([[OWNER, 700]]);
    expect(legsFor(1)).toMatchObject({ toOwner: 700, toPlatform: 300 });
  });

  // The whole point of the column. A green placement paid the owner yellow for
  // ten months because this leg named no account and took the service default.
  it('pays the owner in the currency the placer spent', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      spendType: 'green',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        toAccountId: OWNER,
        toAccountType: 'green',
        // Drawn from the escrow's green too: paying green out of the yellow
        // balance would mint it, which is the mirror of the bug being fixed.
        fromAccountType: 'green',
      }),
      expect.anything()
    );
  });

  // Rows made before the column existed were HELD as yellow whatever was spent,
  // so yellow is what the escrow has for them. Settling one as green would pay
  // out Buzz the escrow never received — which is why nothing backfills this.
  it('settles a placement with no recorded currency as yellow', async () => {
    givenPlacement({ spendType: null });
    await hold();
    // Written by the hold above; cleared to stand in for a legacy row.
    db.placements.get(1)!.spendType = null;

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ toAccountType: 'yellow', fromAccountType: 'yellow' }),
      expect.anything()
    );
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
    holdPlacementEscrow({
      spendType: 'yellow',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

  it.each([
    'approve',
    'decline',
    'expire',
    'removeByOwner',
    'removeByModerator',
    'removeByCosmeticTakedown',
  ] as const)('moves no money the second time: %s', async (action) => {
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
  });

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
    holdPlacementEscrow({
      spendType: 'yellow',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

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
      spendType: 'yellow',
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
      spendType: 'yellow',
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
    holdPlacementEscrow({
      spendType: 'yellow',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

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
      'removeByCosmeticTakedown',
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
      spendType: 'yellow',
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
      spendType: 'yellow',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });
    await Promise.resolve();
    const second = holdPlacementEscrow({
      spendType: 'yellow',
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
    //
    // WHICH caller loses is not the property, and neither is "exactly one wins".
    // Whoever reaches the row second spends an extra query reconciling the
    // currency, so how the two interleave at the per-leg locks is an artefact of
    // how many awaits precede them — they can end up holding one leg each, and
    // then BOTH refuse. That is still safe: a refusal sends the caller into its
    // compensating expire, which refunds the holds that were taken.
    //
    // What must never happen is a caller reporting success over an escrow it did
    // not take. So: no more than one success, and only one Buzz call.
    const fulfilled = [firstResult, secondResult].filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeLessThanOrEqual(1);
    expect([firstResult.status, secondResult.status]).toContain('rejected');
  });
});

describe('the expiry deadline', () => {
  // A null expiresAt is never `<= now()`, so the sweep steps over it forever and
  // the escrow is frozen — the exact failure expiry exists to prevent.
  it('is set when the escrow is taken', async () => {
    givenPlacement({ expiresAt: null });
    await holdPlacementEscrow({
      spendType: 'yellow',
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
      spendType: 'yellow',
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
      holdPlacementEscrow({
        spendType: 'yellow',
        placementId: 1,
        placerId: PLACER,
        surface: 'sticker',
        amount: 1000,
      })
    ).rejects.toThrow(/nothing was charged/);

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
  });

  it('does not take the escrow twice when the hold is retried after a lock failure', async () => {
    givenPlacement();
    lockState.available = false;
    await expect(
      holdPlacementEscrow({
        spendType: 'yellow',
        placementId: 1,
        placerId: PLACER,
        surface: 'sticker',
        amount: 1000,
      })
    ).rejects.toThrow();

    expect(createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(legsFor(1)).toEqual({ holdFee: 300, holdPrincipal: 700 });

    lockState.available = true;
    await holdPlacementEscrow({
      spendType: 'yellow',
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
      spendType: 'yellow',
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
      spendType: 'yellow',
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
        spendType: 'yellow',
        placementId: id,
        placerId: PLACER,
        surface: 'sticker',
        amount: 1000,
      });
      await settlePlacement({ placementId: id, action: 'approve', actorId: OWNER });
    }

    givenPlacement({ id: 4, sellerId: null });
    await holdPlacementEscrow({
      spendType: 'yellow',
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
      spendType: 'yellow',
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
      spendType: 'yellow',
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
      spendType: 'yellow',
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
      spendType: 'yellow',
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
      spendType: 'yellow',
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
      spendType: 'yellow',
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
  // Reached here by forcing the id into the loop, since the candidate query that
  // would now exclude it is SQL and this harness has no database. The branch is
  // still worth holding: it is the canary for a funded settlement that produced
  // no legs, which should be unreachable.
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
      spendType: 'yellow',
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

/**
 * The exclusion is a SQL predicate and this harness has no database, so these
 * assert the query the sweep sends rather than the rows it gets back. Stated
 * plainly because that is weaker provenance than the tests around them: they
 * prove the predicate is asked for, not that Postgres answers it as intended.
 *
 * They are still the assertions that matter here — the predicate's absence is
 * the whole defect, and both fail when it is removed.
 */
describe('the unplanned sweep only considers settlements it could actually finish', () => {
  const rawCalls = () => queryRaw.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][];
  const sqlOf = (call: [TemplateStringsArray, ...unknown[]]) => call[0].join(' ? ');

  it('requires a receipted hold, so an unfunded settlement never enters the batch', async () => {
    await sweepUnplannedSettlements({ olderThanMinutes: 0 });

    const [candidates] = rawCalls();
    // The hold kinds reach the query as a parameter, which a removed predicate
    // cannot leave behind — unlike prose in the SQL, which a rewrite could keep.
    expect(candidates.slice(1)).toContainEqual(['holdFee', 'holdPrincipal']);
    expect(sqlOf(candidates)).toMatch(/EXISTS[\s\S]*"transactionId" IS NOT NULL/);
  });

  it('counts the excluded population into the gauge rather than dropping it', async () => {
    vi.mocked(placementUnfundedSettlementsGauge.set).mockClear();
    // The candidate query first, then the count. Distinct values, so a sweep
    // reading the wrong result cannot pass by coincidence.
    queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 7 }] as never);

    const swept = await sweepUnplannedSettlements({ olderThanMinutes: 0 });

    expect(swept.unfundedOutstanding).toBe(7);
    expect(vi.mocked(placementUnfundedSettlementsGauge.set)).toHaveBeenCalledWith(7);
  });

  it('reports zero rather than undefined when the count comes back empty', async () => {
    vi.mocked(placementUnfundedSettlementsGauge.set).mockClear();
    queryRaw.mockResolvedValue([]);

    const swept = await sweepUnplannedSettlements({ olderThanMinutes: 0 });

    expect(swept.unfundedOutstanding).toBe(0);
    expect(vi.mocked(placementUnfundedSettlementsGauge.set)).toHaveBeenCalledWith(0);
  });
});

describe('the retry budget measures elapsed failure, not sweep frequency', () => {
  // Without a gap between attempts the ceiling is a function of how often the
  // cron runs: a ten-minute schedule would burn all five inside an hour, so a
  // transient outage would permanently strand a leg that only needed waiting out.
  it('skips a leg attempted too recently', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      spendType: 'yellow',
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
      spendType: 'yellow',
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
      spendType: 'yellow',
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
  it('retries only failures that provably never reached the server', async () => {
    givenPlacement();
    await holdPlacementEscrow({
      spendType: 'yellow',
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
    for (const call of calls) {
      // A timeout must not be retried: the abort does not cancel the server, so
      // a second write goes out with the same external id while the first may
      // still be running.
      const timeout = new Error('The operation was aborted due to timeout');
      timeout.name = 'TimeoutError';
      expect(call[1].shouldRetry(timeout)).toBe(false);

      // A 504 means the *gateway* gave up; the write may well have landed. Same
      // outcome-unknown class as the abort, arriving through a status code.
      const gatewayTimeout = new Error('request failed: 504 Gateway Timeout');
      expect(call[1].shouldRetry(gatewayTimeout)).toBe(false);
      const serverError = new Error('request failed: 500 Internal Server Error');
      expect(call[1].shouldRetry(serverError)).toBe(false);

      // ...but a refused connection must retry, because nothing happened.
      // Handing that to runLeg costs an attempt from a budget of five, and 30
      // minutes, for a rolling restart.
      const refused = new TypeError('fetch failed');
      (refused as unknown as { cause: { code: string } }).cause = { code: 'ECONNREFUSED' };
      expect(call[1].shouldRetry(refused)).toBe(true);
    }
  });

  it('bounds every write, and inside the retry gap', () => {
    expect(BUZZ_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    // The whole point of deriving it: the request must be over well before the
    // leg becomes eligible again.
    expect(BUZZ_CALL_TIMEOUT_MS).toBeLessThan(LEG_RETRY_BACKOFF_MINUTES * 60_000);
  });

  // "Make retries less aggressive" reaches for a bigger gap and "recover faster"
  // for a smaller one; unclamped, both produce a timeout that cannot work.
  // This test IS the lower-bound guard. The ceiling clamps in code because that
  // direction fails safe; the floor cannot clamp, because raising a too-short
  // gap's timeout above the gap inverts the invariant. Asserting here rather
  // than throwing at import keeps a bad constant from taking the app down at
  // boot for something CI catches first.
  it('is never longer than the gap it must fit inside, nor too short to complete', () => {
    expect(BUZZ_CALL_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
    expect(BUZZ_CALL_TIMEOUT_MS).toBeLessThan(LEG_RETRY_BACKOFF_MINUTES * 60_000);
    expect(BUZZ_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('a free placement never touches the money path', () => {
  /**
   * Escrow that a free row must not be able to release.
   *
   * Receipted, so `heldAmountsFor` counts it as real Buzz sitting in the escrow
   * account. That state should be unreachable — the free path takes no holds and
   * `holdPlacementEscrow` refuses a free row — and it is exactly the state the
   * guard has to survive, because "unreachable" is a claim about today's callers
   * and PRs 2 and 4 are the callers that do not exist yet.
   *
   * Without this fixture the free-row tests below are vacuous: with no holds,
   * every branch of the payout already computes to zero and is filtered out, so
   * deleting the guard would change nothing they observe.
   */
  const givenReceiptedHolds = () => {
    db.legs.set('1:holdFee', {
      placementId: 1,
      kind: 'holdFee',
      amount: 300,
      transactionId: 'placement-1-holdFee',
      attempts: 1,
      createdAt: new Date(0),
    });
    db.legs.set('1:holdPrincipal', {
      placementId: 1,
      kind: 'holdPrincipal',
      amount: 700,
      transactionId: 'placement-1-holdPrincipal',
      attempts: 1,
      createdAt: new Date(0),
    });
  };

  it('plans nothing on approval, even with escrow sitting behind the row', async () => {
    givenPlacement({ free: true, amount: 0 });
    givenReceiptedHolds();
    clearMoneyMocks();

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(legsFor(1)).toEqual({ holdFee: 300, holdPrincipal: 700 });
    expect(moneyMoved()).toBe(0);
  });

  it('takes no decline fee, so a decline costs the placer nothing', async () => {
    givenPlacement({ free: true, amount: 0 });
    givenReceiptedHolds();
    clearMoneyMocks();

    await settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER });

    expect(legsFor(1)).not.toHaveProperty('feeToOwner');
    expect(moneyMoved()).toBe(0);
  });

  it('refunds nothing on expiry, because nothing was ever taken', async () => {
    givenPlacement({ free: true, amount: 0 });
    givenReceiptedHolds();
    clearMoneyMocks();

    await settlePlacement({ placementId: 1, action: 'expire' });

    expect(legsFor(1)).not.toHaveProperty('principalToPlacer');
    expect(moneyMoved()).toBe(0);
  });

  it('still settles the row, so the slot it holds is released', async () => {
    givenPlacement({ free: true, amount: 0 });

    const { settled, placement } = await settlePlacement({ placementId: 1, action: 'decline' });

    // The money is the part that does nothing. The status transition is the part
    // that matters — it is what takes the placement out of
    // `FREE_SLOT_HOLDING_STATUSES` and hands the slot to the next placer.
    expect(settled).toBe(true);
    expect(placement.status).toBe('declined');
  });

  it('refuses to take escrow at all, rather than holding zero', async () => {
    givenPlacement({ free: true, amount: 0 });
    clearMoneyMocks();

    await expect(
      holdPlacementEscrow({
        placementId: 1,
        placerId: PLACER,
        surface: 'sticker',
        amount: 100,
        spendType: 'yellow',
      })
    ).rejects.toThrow(/free/);

    expect(moneyMoved()).toBe(0);
    expect(legsFor(1)).toEqual({});
  });
});

describe('the accept reward', () => {
  const hold = () =>
    holdPlacementEscrow({
      spendType: 'yellow',
      placementId: 1,
      placerId: PLACER,
      surface: 'sticker',
      amount: 1000,
    });

  it('pays the owner of the space, for the placement, crediting the placer', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(applyAcceptReward).toHaveBeenCalledTimes(1);
    expect(applyAcceptReward).toHaveBeenCalledWith({
      placementId: 1,
      ownerId: OWNER,
      placerId: PLACER,
    });
  });

  it('pays it for a free placement too', async () => {
    givenPlacement({ free: true, amount: 0 });

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(applyAcceptReward).toHaveBeenCalledTimes(1);
  });

  // The reason it hangs off `count > 0` and not off the callers. The ledger key
  // never expires while the daily cap does, so a second presentation of the same
  // placement on a later day spends a tenth of the owner's day and moves no Buzz.
  it('pays nothing on a second approve of the same placement', async () => {
    givenPlacement();
    await hold();
    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });
    applyAcceptReward.mockClear();

    const { settled } = await settlePlacement({
      placementId: 1,
      action: 'approve',
      actorId: OWNER,
    });

    expect(settled).toBe(false);
    expect(applyAcceptReward).not.toHaveBeenCalled();
  });

  it.each(['decline', 'expire', 'removeByOwner', 'removeByModerator'] as const)(
    'pays nothing when the placement settles as %s',
    async (action) => {
      givenPlacement();
      await hold();

      const { settled } = await settlePlacement({ placementId: 1, action, actorId: OWNER });

      // The settle has to have happened, or "the reward did not fire" is true of
      // a call that did nothing at all and the assertion below proves nothing.
      expect(settled).toBe(true);
      expect(applyAcceptReward).not.toHaveBeenCalled();
    }
  );

  /**
   * 🔴 **Auto-accept pays, and that is designed** — but read what this asserts.
   *
   * This service has no notion of space mode. Both sticker approve paths — the
   * owner acting through `actOnStickerPlacement`, and `createStickerPlacement`
   * settling inline at placement time when `space.mode === 'auto'` — arrive here
   * as the identical call, which is exactly why the reward hangs off the settle
   * rather than off either caller. So this cannot tell them apart, and is not
   * named as though it can: what it pins is that **any** approve pays.
   *
   * The auto half is pinned in two places that together need no inference:
   * 'settles an auto space immediately' in sticker-placement.service.test.ts
   * asserts that path issues exactly this settle, and this asserts that settle
   * pays.
   *
   * Written out because the intent otherwise lives only in a Discord thread.
   * Justin's decision, in the intent doc: creators switching from Review to Auto
   * Accept to collect this is a fine outcome, not a leak. A reviewer reading the
   * code alone has already once read auto-mode paying as an oversight and
   * recommended removing it. If you are here to make auto stop paying, that is
   * the conversation you are having, and it is Justin's to have.
   */
  it('pays on any approve, whichever of the two sticker paths issued it', async () => {
    givenPlacement();
    await hold();

    const { settled } = await settlePlacement({
      placementId: 1,
      action: 'approve',
      actorId: OWNER,
    });

    expect(settled).toBe(true);
    expect(applyAcceptReward).toHaveBeenCalledTimes(1);
  });

  /**
   * 🔴 **Exactly one reward per surface, and this is the only place that can see
   * it.** The tempting cleanup after both reward PRs land is to consolidate here
   * — move the remix `apply` into `rewardAccepted` — and leave the call in
   * `actOnRemixGallerySubmission` in place. That double-pays 20 Blue Buzz on
   * every remix accept, and nothing else goes red: the remix suite mocks
   * `settlePlacement` wholesale so it cannot observe this service firing
   * anything, the two ledger keys differ by type, and the daily cap hash is
   * keyed `userId:type` so both grants look legitimate to both caps.
   *
   * The consolidation is a recorded follow-up and is fine to do — but it must
   * MOVE the remix call, not add one. This test is what tells you which you did.
   *
   * The remix half was inert while `remixAcceptReward` did not exist on this
   * branch — a tripwire armed on merge rather than coverage. #4013 landed it, so
   * both halves are live and the mocked path now resolves to a real module.
   */
  it('grants exactly one reward per surface, and never the other surface reward', async () => {
    givenPlacement({ id: 1, surface: 'sticker' });
    givenPlacement({ id: 2, surface: 'remixGallery' });

    const sticker = await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });
    expect(sticker.settled).toBe(true);
    expect(applyAcceptReward).toHaveBeenCalledTimes(1);
    expect(applyRemixReward).not.toHaveBeenCalled();

    applyAcceptReward.mockClear();

    const remix = await settlePlacement({ placementId: 2, action: 'approve', actorId: OWNER });
    expect(remix.settled).toBe(true);
    expect(applyRemixReward).not.toHaveBeenCalled();
    expect(applyAcceptReward).not.toHaveBeenCalled();
  });

  // 🔴 If you are here because you added a `remixGallery` branch to
  // `rewardAccepted`: that reward is already granted from
  // `actOnRemixGallerySubmission`, the only path by which a remix submission is
  // approved. A branch here does not replace that grant, it doubles it — and no
  // guard either reward owns can tell: the types differ, so the ledger keys
  // differ, and the daily cap hash is keyed `userId:type`. This test is the only
  // thing standing between that edit and paying every remix approval twice.
  it('pays nothing on a remix approval, which is granted from its own surface', async () => {
    givenPlacement({ surface: 'remixGallery' });
    await hold();

    const { settled } = await settlePlacement({
      placementId: 1,
      action: 'approve',
      actorId: OWNER,
    });

    // Establishes the approval actually happened, so this is "approved and paid
    // nothing" rather than a call that quietly did nothing at all.
    expect(settled).toBe(true);
    expect(applyAcceptReward).not.toHaveBeenCalled();
    // The reward the comment above is about. Without this the test asserted only
    // that the STICKER reward stayed out of a remix approval, so the exact edit
    // it warns against — a `remixGallery` branch here — left it green.
    expect(applyRemixReward).not.toHaveBeenCalled();
  });

  // The approval has already paid the owner out of escrow by this point. A
  // throw here would 500 a request whose money has moved, and the caller would
  // read that as the approval having failed.
  it('does not fail the approval when the reward throws', async () => {
    givenPlacement();
    await hold();
    applyAcceptReward.mockRejectedValue(new Error('clickhouse is gone'));

    const { settled, placement } = await settlePlacement({
      placementId: 1,
      action: 'approve',
      actorId: OWNER,
    });

    expect(settled).toBe(true);
    expect(placement.status).toBe('approved');
    expect(legsFor(1)).toMatchObject({ toOwner: 700 });
  });

  /**
   * The log is the entire compensation for swallowing the throw. Without it a
   * reward that never arrived leaves no trace at all on a money path — and
   * `.catch(() => null)` is a plausible-looking edit that produces exactly that
   * while every other assertion here stays green.
   *
   * Rejected with a non-`Error` on purpose: that is what tells `.message` apart
   * from the `instanceof` narrowing, and a bare `.message` logs `undefined` —
   * the failure reads as "the reward failed, cause unknown", which is the shape
   * that makes an outage unreadable at 3am.
   */
  it('reports a swallowed reward failure, whatever was thrown', async () => {
    givenPlacement();
    await hold();
    applyAcceptReward.mockRejectedValue('clickhouse is gone');

    const { settled } = await settlePlacement({
      placementId: 1,
      action: 'approve',
      actorId: OWNER,
    });

    expect(settled).toBe(true);
    expect(vi.mocked(logToAxiom)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'placement-escrow',
        message: 'accept reward failed',
        placementId: 1,
        error: 'clickhouse is gone',
      })
    );
  });
});

/**
 * The strings here are the whole of what a user sees for a placement in their
 * Buzz history, so the leg name and the placement id — both internal, both
 * meaningless to the reader — must not survive into one.
 *
 * The sweep at the end is what guards a leg added later: a per-string assertion
 * only covers the legs someone remembered to list.
 */
describe('what a placement says in the Buzz ledger', () => {
  const hold = (surface: 'sticker' | 'remixGallery' = 'sticker') =>
    holdPlacementEscrow({
      spendType: 'yellow',
      placementId: 1,
      placerId: PLACER,
      surface,
      amount: 1000,
    });

  // Not `String(...)`: coercing turns a missing description into the literal
  // 'undefined', which carries no leg name and no digit and so satisfies every
  // assertion below.
  const descriptionsWritten = (): unknown[] =>
    [
      ...createMultiAccountBuzzTransaction.mock.calls,
      ...createBuzzTransaction.mock.calls,
      ...refundMultiAccountTransaction.mock.calls,
    ].map((call) => call[0].description);

  it('names the two holds in words the placer can read, and links both to the image', async () => {
    givenPlacement();
    await hold();

    expect(descriptionsWritten()).toEqual([
      'Sticker placement fee, held while the creator decides',
      'Sticker placement, held while the creator decides',
    ]);
    // Asserted positively on the hold legs, not only negatively in the
    // non-image case below: these are the rows whose link depends on the
    // widened `select`, and the fake honours `select`, so dropping a column
    // from it lands here.
    for (const call of createMultiAccountBuzzTransaction.mock.calls)
      expect(call[0].details).toEqual({ entityType: 'Image', entityId: 99 });
  });

  it('tells the owner what landed on their image, and links the row to it', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        toAccountId: OWNER,
        description: 'Someone placed a sticker on your image',
        // `/user/transactions` builds its "View Image" link from these two.
        details: { entityType: 'Image', entityId: 99 },
      }),
      expect.anything()
    );
  });

  it('describes a refund without claiming a reason it cannot know', async () => {
    givenPlacement();
    await hold();

    await settlePlacement({ placementId: 1, action: 'decline', actorId: OWNER });

    expect(refundMultiAccountTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: 'placement-1-holdPrincipal',
        description: 'Refund: your sticker placement',
        details: { entityType: 'Image', entityId: 99 },
      }),
      expect.anything()
    );
    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        toAccountId: OWNER,
        description: 'Fee for a sticker you declined',
      }),
      expect.anything()
    );
  });

  it('calls a remix a remix rather than a sticker', async () => {
    givenPlacement({ surface: 'remixGallery' });
    await hold('remixGallery');

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    expect(createBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Someone added a remix to your gallery' }),
      expect.anything()
    );
    expect(descriptionsWritten().join(' ')).not.toContain('ticker');
  });

  // The link is built from the target, so a target that is not an image must
  // produce no link at all rather than one pointing at /images/<some other id>.
  it('omits the link when the placement is not on an image', async () => {
    givenPlacement({ targetType: 'video' });
    await hold();

    await settlePlacement({ placementId: 1, action: 'approve', actorId: OWNER });

    for (const call of [
      ...createMultiAccountBuzzTransaction.mock.calls,
      ...createBuzzTransaction.mock.calls,
    ])
      expect(call[0].details).toBeUndefined();
  });

  // Each case pins the exact number of rows its action writes. `toBeGreaterThan`
  // was satisfied by the two holds alone — before the settle ran — so a settle
  // that paid nothing swept two known-clean strings and passed.
  const settlements = [
    {
      name: 'an approval',
      arrange: () => givenPlacement(),
      // Two holds and toOwner. toPlatform keeps the money in escrow and writes
      // no Buzz row.
      writes: 3,
      settle: () => settlePlacement({ placementId: 1, action: 'approve' as const, actorId: OWNER }),
    },
    {
      // The only path that reaches toSeller, and therefore the only one that
      // sweeps its copy.
      name: 'an approval paying a seller',
      arrange: () => {
        givenPlacement({ sellerId: SELLER });
        storedShares({ seller: 0.2, platform: 0.1 });
      },
      writes: 4,
      settle: () => settlePlacement({ placementId: 1, action: 'approve' as const, actorId: OWNER }),
    },
    {
      name: 'a decline',
      arrange: () => givenPlacement(),
      // Two holds, the owner's fee, and the placer's principal refund.
      writes: 4,
      settle: () => settlePlacement({ placementId: 1, action: 'decline' as const, actorId: OWNER }),
    },
    {
      name: 'an expiry',
      arrange: () => givenPlacement(),
      // Two holds and both refunds.
      writes: 4,
      settle: () => settlePlacement({ placementId: 1, action: 'expire' as const }),
    },
  ];

  it.each(settlements)('leaks no leg name or placement id through $name', async (settlement) => {
    settlement.arrange();
    await hold();

    await settlement.settle();

    const written = descriptionsWritten();
    expect(written).toHaveLength(settlement.writes);

    for (const description of written) {
      expect(description).toBeTypeOf('string');

      // The lists the code pays from, so a leg added later is swept without
      // anyone remembering to add it here.
      for (const kind of [...PLACEMENT_HOLD_KINDS, ...PAYOUT_KINDS])
        expect(description).not.toContain(kind);

      expect(description).not.toMatch(/placement \d/i);
      expect(String(description).length).toBeLessThanOrEqual(100);
    }
  });
});
