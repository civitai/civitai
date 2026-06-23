import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W3 flow A — buzz SPEND attribution service coverage. TRACK-ONLY (mirrors
 * #2629's membership rework): the write records the EVENT + the money BASIS
 * (gross USD value of the Buzz burned) only — NO rate card is applied at write
 * time. The author bounty is deferred to a payout-time backpay over
 * status='tracked' rows. The interesting surface is:
 *   - track-only row shape: status='tracked', author_share=0,
 *     spend_share_pct=0, rate_card_version='unrated', gross recorded
 *   - the write NEVER calls computeSpendShare (the share is deferred)
 *   - self-spend wash (spender == app owner → voided + 0 share)
 *   - internal-owner wash (app owner ∈ internalAppOwnerUserIds → voided)
 *   - idempotency via the (workflow_id, app_block_id) UNIQUE (P2002)
 *   - missing-app guard
 *   - the platform-funded-bounty ledger invariant (0 ≤ share ≤ gross)
 *
 * Prisma + logger are mocked at the module boundary so the test stays
 * in-process and deterministic. The Prom counter is real (the service
 * wraps it in try/catch) — no need to mock it.
 */

class FakePrismaKnownError extends Error {
  code: string;
  clientVersion: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.clientVersion = 'test';
  }
}

const { mockDbRead, mockDbWrite, mockLog } = vi.hoisted(() => ({
  mockDbRead: {
    oauthClient: { findUnique: vi.fn() },
    blockSpendAttribution: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    blockSpendAttribution: { create: vi.fn() },
  },
  mockLog: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));

// Spy on computeSpendShare so the track-only contract is testable: the write
// must NEVER call it (the bounty is deferred to payout). Everything else from
// rate-card stays real.
const computeSpendShareSpy = vi.hoisted(() => vi.fn());
vi.mock('../rate-card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rate-card')>();
  return {
    ...actual,
    computeSpendShare: (...args: Parameters<typeof actual.computeSpendShare>) => {
      computeSpendShareSpy(...args);
      return actual.computeSpendShare(...args);
    },
  };
});

import {
  AttributionAppMissingError,
  buzzSpendToUsdCents,
  recordSpendAttribution,
  UNRATED_RATE_CARD_VERSION,
  type RecordSpendAttributionInput,
} from '../buzz-attribution.service';
import { ACTIVE_RATE_CARD } from '../rate-card';

const APP_ID = 'app_test';
const APP_BLOCK_ID = 'apb_test';
const APP_OWNER_USER_ID = 999;
const SPENDER_ID = 100;
const WORKFLOW_ID = 'wf_abc123';

function fakeInput(over: Partial<RecordSpendAttributionInput> = {}): RecordSpendAttributionInput {
  return {
    userId: SPENDER_ID,
    buzzAmount: 5000, // 5000 Buzz = $5 = 500 cents
    workflowId: WORKFLOW_ID,
    appId: APP_ID,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'bki_test123',
    modelId: 555,
    ...over,
  };
}

// Echo the data back as the "created" row so assertions can read what the
// service computed (mirrors the real Prisma create return shape, narrowed
// to the service's `select`).
function createEchoesData() {
  mockDbWrite.blockSpendAttribution.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: data.id,
      status: data.status,
      appOwnerShareCents: data.appOwnerShareCents,
      spendSharePct: data.spendSharePct,
      grossValueCents: data.grossValueCents,
      rateCardVersion: data.rateCardVersion,
      voidedReason: data.voidedReason ?? null,
    })
  );
}

beforeEach(() => {
  mockDbRead.oauthClient.findUnique.mockReset();
  mockDbRead.blockSpendAttribution.findUnique.mockReset();
  mockDbWrite.blockSpendAttribution.create.mockReset();
  mockLog.mockReset();
  computeSpendShareSpy.mockReset();
  // Default: app exists, owned by a different user than the spender.
  mockDbRead.oauthClient.findUnique.mockResolvedValue({
    id: APP_ID,
    userId: APP_OWNER_USER_ID,
  });
  createEchoesData();
});

describe('buzzSpendToUsdCents', () => {
  it('converts Buzz to USD cents at the 1000:1 ratio, floored', () => {
    expect(buzzSpendToUsdCents(1000)).toBe(100); // $1
    expect(buzzSpendToUsdCents(5000)).toBe(500); // $5
    expect(buzzSpendToUsdCents(4999)).toBe(499); // floors, never over-states
    expect(buzzSpendToUsdCents(10)).toBe(1); // 1 cent
    expect(buzzSpendToUsdCents(9)).toBe(0); // sub-cent floors to 0
    expect(buzzSpendToUsdCents(-100)).toBe(0); // garbage clamps to 0
  });
});

describe('recordSpendAttribution', () => {
  it('TRACK-ONLY: writes exactly one tracked row — event + gross, author=0, NO rate stamped', async () => {
    const res = await recordSpendAttribution(fakeInput());

    // Exactly one write.
    expect(mockDbWrite.blockSpendAttribution.create).toHaveBeenCalledTimes(1);
    expect(res.written).toBe(true);

    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];

    // Author is the appBlock's owning OauthClient user (server-derived).
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    // MONEY BASIS recorded: gross = USD value of the Buzz burned (5000 -> 500).
    expect(data.grossValueCents).toBe(500);
    // NO rate applied at write: author share 0, pct 0, version 'unrated'.
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.spendSharePct).toBe(0);
    expect(data.rateCardVersion).toBe(UNRATED_RATE_CARD_VERSION);
    expect(data.rateCardVersion).not.toBe(ACTIVE_RATE_CARD.version);
    // The write must NOT consult the spend rate card — the bounty is deferred.
    expect(computeSpendShareSpy).not.toHaveBeenCalled();
    // Not self/internal → tracked (share-pending), not voided.
    expect(data.status).toBe('tracked');
    expect(data.voidedReason).toBeNull();
    // Server-derived context preserved.
    expect(data.appId).toBe(APP_ID);
    expect(data.appBlockId).toBe(APP_BLOCK_ID);
    expect(data.workflowId).toBe(WORKFLOW_ID);
    expect(data.userId).toBe(SPENDER_ID);
    expect(res.row.status).toBe('tracked');
  });

  it('ledger invariant: 0 ≤ author_share ≤ gross — and author is always 0 at write (track-only)', async () => {
    await recordSpendAttribution(fakeInput({ buzzAmount: 123456 }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.grossValueCents).toBeGreaterThan(0);
    expect(data.appOwnerShareCents).toBeGreaterThanOrEqual(0);
    expect(data.appOwnerShareCents).toBeLessThanOrEqual(data.grossValueCents);
    // Track-only: no rate baked in, so the share is identically 0.
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.spendSharePct).toBe(0);
  });

  it('MUTATION-CHECK: author share + pct are 0 regardless of the active rate card (no rate applied)', async () => {
    // Active card defines spendSharePct=5 (a non-zero placeholder). A
    // track-only write must NOT apply it — author stays 0 and version stays
    // 'unrated' even though the card carries a real rate. If the write
    // regressed to applying computeSpendShare/the 5% card, these assertions
    // (and the not-called spy) would fail.
    expect(ACTIVE_RATE_CARD.spendSharePct).toBe(5);
    await recordSpendAttribution(fakeInput({ buzzAmount: 100000 })); // $100 gross
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.grossValueCents).toBe(10000);
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.spendSharePct).toBe(0);
    expect(data.rateCardVersion).toBe(UNRATED_RATE_CARD_VERSION);
    expect(computeSpendShareSpy).not.toHaveBeenCalled();
  });

  it('self-spend (spender == app owner) → voided, zero share', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValue({
      id: APP_ID,
      userId: SPENDER_ID, // owner == spender
    });
    const res = await recordSpendAttribution(fakeInput());
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.status).toBe('voided');
    expect(data.voidedReason).toBe('self_spend');
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.spendSharePct).toBe(0);
    expect(res.row.status).toBe('voided');
  });

  it('internal-owner (app owner ∈ internalAppOwnerUserIds) → voided, zero share', async () => {
    // The owner is a different user than the spender (so NOT self-spend), but
    // sits on the active card's internal-owner list — its rows must still be
    // voided so they never enter the backpay. Temporarily inject the owner
    // into the real list (restored after), since V5 ships with an empty list.
    const internalList = ACTIVE_RATE_CARD.internalAppOwnerUserIds;
    internalList.push(APP_OWNER_USER_ID);
    try {
      const res = await recordSpendAttribution(fakeInput());
      const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
      expect(data.status).toBe('voided');
      expect(data.voidedReason).toBe('internal_owner');
      expect(data.appOwnerShareCents).toBe(0);
      expect(data.spendSharePct).toBe(0);
      expect(res.row.status).toBe('voided');
    } finally {
      internalList.pop();
    }
  });

  it('idempotency: a second call for the same workflow returns the existing row, no second write', async () => {
    // First write succeeds.
    const first = await recordSpendAttribution(fakeInput());
    expect(first.written).toBe(true);

    // Second write hits the (workflow_id, app_block_id) UNIQUE → P2002.
    mockDbWrite.blockSpendAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('dup', 'P2002')
    );
    mockDbRead.blockSpendAttribution.findUnique.mockResolvedValueOnce({
      id: 'bsa_existing',
      status: 'pending',
      appOwnerShareCents: 25,
      spendSharePct: 5,
      grossValueCents: 500,
      rateCardVersion: 'v4',
      voidedReason: null,
    });

    const second = await recordSpendAttribution(fakeInput());
    expect(second.written).toBe(false);
    expect(second.row.id).toBe('bsa_existing');

    // Looked up by the workflow+app idempotency key.
    expect(mockDbRead.blockSpendAttribution.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workflowId_appBlockId: { workflowId: WORKFLOW_ID, appBlockId: APP_BLOCK_ID } },
      })
    );
  });

  it('aborts (throws AttributionAppMissingError) when the app is gone — no orphan row', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValue(null);
    await expect(recordSpendAttribution(fakeInput())).rejects.toBeInstanceOf(
      AttributionAppMissingError
    );
    expect(mockDbWrite.blockSpendAttribution.create).not.toHaveBeenCalled();
  });

  it('re-throws a non-P2002 DB error (real failures are not swallowed as idempotent)', async () => {
    mockDbWrite.blockSpendAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('connection lost', 'P1001')
    );
    await expect(recordSpendAttribution(fakeInput())).rejects.toMatchObject({
      code: 'P1001',
    });
    // Did NOT fall through to the idempotent lookup.
    expect(mockDbRead.blockSpendAttribution.findUnique).not.toHaveBeenCalled();
  });
});
