import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W3 flow A — buzz SPEND attribution service coverage. The interesting
 * surface is:
 *   - server-derived author bounty (gross USD from Buzz, share via the
 *     active spend rate card)
 *   - self-spend wash (spender == app owner → voided + 0 share)
 *   - internal-owner wash (app owner ∈ internalAppOwnerUserIds)
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

import {
  AttributionAppMissingError,
  buzzSpendToUsdCents,
  recordSpendAttribution,
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
  it('writes exactly one pending row with author=appBlock owner, gross=USD cost, share=cost×rate (floored)', async () => {
    const res = await recordSpendAttribution(fakeInput());

    // Exactly one write.
    expect(mockDbWrite.blockSpendAttribution.create).toHaveBeenCalledTimes(1);
    expect(res.written).toBe(true);

    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];

    // Author is the appBlock's owning OauthClient user (server-derived).
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    // Gross = USD value of the Buzz burned: 5000 Buzz -> 500 cents.
    expect(data.grossValueCents).toBe(500);
    // Share = gross * active spend rate, floored.
    const expectedShare = Math.floor((500 * ACTIVE_RATE_CARD.spendSharePct) / 100);
    expect(data.appOwnerShareCents).toBe(expectedShare);
    expect(data.spendSharePct).toBe(ACTIVE_RATE_CARD.spendSharePct);
    // Not self-spend → pending, not voided.
    expect(data.status).toBe('pending');
    expect(data.voidedReason).toBeNull();
    // Server-derived context preserved.
    expect(data.appId).toBe(APP_ID);
    expect(data.appBlockId).toBe(APP_BLOCK_ID);
    expect(data.workflowId).toBe(WORKFLOW_ID);
    expect(data.userId).toBe(SPENDER_ID);
    expect(data.rateCardVersion).toBe(ACTIVE_RATE_CARD.version);
  });

  it('ledger invariant: 0 ≤ author_share ≤ gross (platform-funded bounty)', async () => {
    await recordSpendAttribution(fakeInput({ buzzAmount: 123456 }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.appOwnerShareCents).toBeGreaterThanOrEqual(0);
    expect(data.appOwnerShareCents).toBeLessThanOrEqual(data.grossValueCents);
    // And re-derivable from the stamped rate.
    expect(data.appOwnerShareCents).toBe(
      Math.floor((data.grossValueCents * data.spendSharePct) / 100)
    );
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
