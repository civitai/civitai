import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ledger-backed idempotency for the App Blocks tip (audit 🟡-1).
 *
 * `createBuzzTipTransactionHandler` normally mints a fresh `uuid()` per call for the
 * tip's `externalTransactionId`, bypassing the Buzz ledger's native idempotency (a
 * duplicate `externalTransactionId` is a benign "money already moved" conflict). When
 * the App Blocks tip endpoint threads a client `idempotencyKey`, the handler DERIVES
 * the id deterministically (`block-tip:${fromUserId}:${key}-${toAccountId}`), so a
 * retry AFTER the Redis sentinel has expired (a crash between charge and finalize)
 * collides on the Postgres unique constraint = money moves ONCE.
 *
 * These tests exercise the REAL handler with a mocked `createBuzzTransactionMany`
 * (the ledger boundary) that models the unique-constraint dedup, so the derivation +
 * the money-moves-once property are verified for real.
 */

const { mockCreateMany, mockGetUserBuzzAccount, mockUpsertBuzzTip } = vi.hoisted(() => ({
  mockCreateMany: vi.fn(),
  mockGetUserBuzzAccount: vi.fn(),
  mockUpsertBuzzTip: vi.fn(),
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...a: unknown[]) => mockCreateMany(...(a as [])),
  getUserBuzzAccount: (...a: unknown[]) => mockGetUserBuzzAccount(...(a as [])),
  upsertBuzzTip: (...a: unknown[]) => mockUpsertBuzzTip(...(a as [])),
  // Unused by the tip path but imported by the controller module — stub so the
  // module resolves without pulling the real buzz client (which connects on import).
  completeStripeBuzzTransaction: vi.fn(),
  getDailyCompensationRewardByUser: vi.fn(),
  getMultipliersForUser: vi.fn(),
  getTransactionsReport: vi.fn(),
  getUserBuzzTransactions: vi.fn(),
  getUserBuzzTransactionsMulti: vi.fn(),
  previewMultiAccountTransaction: vi.fn(),
}));

const { mockUserFindMany, mockUserFindUnique } = vi.hoisted(() => ({
  mockUserFindMany: vi.fn(),
  mockUserFindUnique: vi.fn(),
}));
vi.mock('~/server/db/client', () => ({
  dbWrite: {
    user: {
      findMany: (...a: unknown[]) => mockUserFindMany(...(a as [])),
      findUnique: (...a: unknown[]) => mockUserFindUnique(...(a as [])),
    },
  },
}));
vi.mock('~/server/services/user.service', () => ({ amIBlockedByUser: vi.fn(async () => false) }));
vi.mock('~/server/services/entity-collaborator.service', () => ({
  getEntityCollaborators: vi.fn(async () => []),
}));
vi.mock('~/server/services/image.service', () => ({ getImageById: vi.fn(async () => null) }));

// Hoisted so the 🔴-2 tests can assert these NON-idempotent side effects do not fire
// for a transaction the ledger deduped.
const { mockCreateNotification, mockUpdateEntityMetric } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockUpdateEntityMetric: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: (...a: unknown[]) => mockCreateNotification(...(a as [])),
}));
vi.mock('~/server/utils/metric-helpers', () => ({
  updateEntityMetric: (...a: unknown[]) => mockUpdateEntityMetric(...(a as [])),
}));
vi.mock('~/server/rewards/active/dailyBoost.reward', () => ({
  dailyBoostReward: { apply: vi.fn() },
}));

import { createBuzzTipTransactionHandler } from '../buzz.controller';

// A ledger mock that dedupes on externalTransactionId — a duplicate id is a benign
// conflict (money already moved), NOT a new debit. Returns the {transactions, conflicts}
// shape the real batch endpoint returns.
function installLedger() {
  const moved = new Set<string>();
  let debits = 0;
  mockCreateMany.mockImplementation(async (txns: Array<{ externalTransactionId: string }>) => {
    const transactions: string[] = [];
    const conflicts: string[] = [];
    for (const t of txns) {
      if (moved.has(t.externalTransactionId)) conflicts.push(t.externalTransactionId);
      else {
        moved.add(t.externalTransactionId);
        debits += 1;
        transactions.push(`tx_${debits}`);
      }
    }
    return { transactions, conflicts };
  });
  return { debits: () => debits };
}

function ctxUser() {
  // createdAt well past the 24h membership gate.
  return { user: { id: 42, createdAt: new Date('2020-01-01T00:00:00Z') } } as never;
}
const baseInput = {
  toAccountId: 5,
  amount: 100,
  fromAccountType: 'yellow' as const,
  toAccountType: 'yellow' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUserBuzzAccount.mockResolvedValue([{ balance: 1_000_000 }]);
  mockUserFindMany.mockResolvedValue([]); // no banned targets
  mockUserFindUnique.mockResolvedValue({ username: 'sender' });
  mockUpsertBuzzTip.mockResolvedValue(undefined);
  mockCreateNotification.mockResolvedValue(undefined);
  mockUpdateEntityMetric.mockResolvedValue(undefined);
});

describe('createBuzzTipTransactionHandler — ledger-backed idempotency (audit 🟡-1)', () => {
  it('with a key: a same-key retry presents a DETERMINISTIC externalTransactionId → money moves ONCE', async () => {
    const ledger = installLedger();
    await createBuzzTipTransactionHandler({
      input: baseInput,
      ctx: ctxUser(),
      idempotencyKey: 'idem-abc',
    });
    // Simulate the crash window: the Redis sentinel has expired, so the endpoint
    // re-runs the handler with the SAME client key.
    await createBuzzTipTransactionHandler({
      input: baseInput,
      ctx: ctxUser(),
      idempotencyKey: 'idem-abc',
    });

    // 🔴 The load-bearing assertion: exactly ONE debit across the two calls — the 2nd
    // collided on the ledger's unique externalTransactionId.
    expect(ledger.debits()).toBe(1);
    const ext1 = mockCreateMany.mock.calls[0][0][0].externalTransactionId;
    const ext2 = mockCreateMany.mock.calls[1][0][0].externalTransactionId;
    // Deterministic + delimiter-injective (block-tip:<fromUserId>:<key>-<toAccountId>).
    expect(ext1).toBe('block-tip:42:idem-abc-5');
    expect(ext2).toBe(ext1);
  });

  it("WITHOUT a key: each call mints a fresh uuid externalTransactionId (no ledger dedup — today's behavior)", async () => {
    const ledger = installLedger();
    await createBuzzTipTransactionHandler({ input: baseInput, ctx: ctxUser() });
    await createBuzzTipTransactionHandler({ input: baseInput, ctx: ctxUser() });

    const ext1 = mockCreateMany.mock.calls[0][0][0].externalTransactionId;
    const ext2 = mockCreateMany.mock.calls[1][0][0].externalTransactionId;
    // Non-deterministic uuid form (`tip-<uuid>---by-<fromUserId>-<toAccountId>`),
    // DIFFERENT per call → two distinct debits (no ledger dedup).
    expect(ext1).toMatch(/^tip-.+-by-42-5$/);
    expect(ext1).not.toContain('block-tip');
    expect(ext2).not.toBe(ext1);
    expect(ledger.debits()).toBe(2);
  });

  it('with a key: the derived externalTransactionId carries the entity context via the sharedId key (still deterministic)', async () => {
    installLedger();
    await createBuzzTipTransactionHandler({
      input: { ...baseInput, entityType: 'Image', entityId: 99 },
      ctx: ctxUser(),
      idempotencyKey: 'idem-xyz',
    });
    // The key-derived id ignores entityType/entityId (the client key already uniquely
    // identifies the logical tip), so a retry with the same key collides regardless.
    expect(mockCreateMany.mock.calls[0][0][0].externalTransactionId).toBe(
      'block-tip:42:idem-xyz-5'
    );
  });
});

/**
 * 🔴-2 — a ledger CONFLICT means the money already moved on an EARLIER call, so this
 * call debited NOTHING. The three side effects (`upsertBuzzTip`, the `tip-received`
 * notification, the Image Buzz metric) are all NON-idempotent, so firing them anyway
 * credits a SECOND tip for money that moved once: a phantom tip.
 *
 * This state is ONLY reachable because of the deterministic `externalTransactionId`
 * this PR introduced — with the legacy per-call `uuid()` id `conflicts` was always
 * empty here. The prior test suite only asserted `debits() === 1`, which is exactly
 * why the phantom side effects slipped through.
 */
describe('createBuzzTipTransactionHandler — ledger CONFLICT side effects (audit 🔴-2)', () => {
  it('🔴 a deduped tip produces ZERO additional side effects (no BuzzTip row, no notification, no metric)', async () => {
    const ledger = installLedger();
    const input = { ...baseInput, entityType: 'Image' as const, entityId: 99 };

    // First tip: money moves, side effects fire.
    await createBuzzTipTransactionHandler({
      input,
      ctx: ctxUser(),
      idempotencyKey: 'idem-dup',
    });
    expect(ledger.debits()).toBe(1);
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(1);
    expect(mockUpdateEntityMetric).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mockUserFindMany.mockResolvedValue([]);
    mockUserFindUnique.mockResolvedValue({ username: 'sender' });

    // The reachable scenario from the audit: same key, same recipient, a DIFFERENT
    // entityId (the derivation deliberately ignores the entity — see the test above),
    // after the 10-min Redis sentinel expired. The ledger id is byte-identical → a
    // conflict → ZERO Buzz moves. Without the fix, image 100 gets +100 Buzz, a
    // BuzzTip row, and a 200.
    const result = await createBuzzTipTransactionHandler({
      input: { ...input, entityId: 100 },
      ctx: ctxUser(),
      idempotencyKey: 'idem-dup',
    });

    // 🔴 The load-bearing assertions: still exactly ONE debit, and NOTHING else fired.
    expect(ledger.debits()).toBe(1);
    expect(mockUpsertBuzzTip).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
    expect(mockUpdateEntityMetric).not.toHaveBeenCalled();
    // Reported up so the App Blocks tip endpoint can refund the daily-cap
    // reservation it burned for Buzz that never moved.
    expect(result.deduped).toBe(true);
    expect(result.dedupedAmount).toBe(100);
  });

  it('🔴 a deduped ENTITY-LESS tip fires no `tip-received` notification (uuid key gives it no dedup)', async () => {
    const ledger = installLedger();
    // No entityType/entityId → the notification branch.
    await createBuzzTipTransactionHandler({
      input: baseInput,
      ctx: ctxUser(),
      idempotencyKey: 'idem-note',
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mockUserFindMany.mockResolvedValue([]);
    mockUserFindUnique.mockResolvedValue({ username: 'sender' });

    await createBuzzTipTransactionHandler({
      input: baseInput,
      ctx: ctxUser(),
      idempotencyKey: 'idem-note',
    });
    expect(ledger.debits()).toBe(1);
    // The notification key is `tip-received:${uuid()}` — it has NO dedup of its own,
    // so nothing else would have stopped a second "you received a tip".
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('CONTROL: a normally-settled tip still fires every side effect and reports no dedupe', async () => {
    installLedger();
    const result = await createBuzzTipTransactionHandler({
      input: { ...baseInput, entityType: 'Image' as const, entityId: 99 },
      ctx: ctxUser(),
      idempotencyKey: 'idem-fresh',
    });
    expect(mockUpsertBuzzTip).toHaveBeenCalledTimes(1);
    expect(mockUpdateEntityMetric).toHaveBeenCalledTimes(1);
    expect(result.deduped).toBe(false);
    expect(result.dedupedAmount).toBe(0);
  });

  it('the metric + BuzzTip amount tracks only what SETTLED, not what was attempted', async () => {
    installLedger();
    await createBuzzTipTransactionHandler({
      input: { ...baseInput, entityType: 'Image' as const, entityId: 99 },
      ctx: ctxUser(),
      idempotencyKey: 'idem-amt',
    });
    expect(mockUpdateEntityMetric).toHaveBeenCalledWith(
      expect.objectContaining({ metricType: 'Buzz', amount: 100 })
    );
    expect(mockUpsertBuzzTip).toHaveBeenCalledWith(expect.objectContaining({ amount: 100 }));
  });
});
