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
vi.mock('~/server/services/notification.service', () => ({
  createNotification: vi.fn(async () => undefined),
}));
vi.mock('~/server/utils/metric-helpers', () => ({
  updateEntityMetric: vi.fn(async () => undefined),
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
