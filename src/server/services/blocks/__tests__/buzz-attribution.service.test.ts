import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Prisma client is stale in this worktree (CI regenerates), so
 * Prisma.PrismaClientKnownRequestError isn't constructible. We
 * duck-type the error shape — same as the service does at runtime.
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

/**
 * Coverage for the buzz-attribution service. The interesting surface is:
 *   - rate-card application against each scope
 *   - self-purchase wash (publisher == purchaser → voided + 0 share)
 *   - idempotency via P2002 unique-violation handling
 *   - missing-app guard
 *   - void path for refunds
 *
 * Prisma + logger are mocked at the module boundary so the test stays
 * in-process and deterministic.
 */

const { mockDbRead, mockDbWrite, mockLog } = vi.hoisted(() => ({
  mockDbRead: {
    oauthClient: { findUnique: vi.fn() },
    blockBuzzAttribution: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    blockBuzzAttribution: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
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
  recordAttribution,
  REFUND_WINDOWS_DAYS,
  voidAttributionsForPayment,
} from '../buzz-attribution.service';
import type { BlockAttribution } from '~/server/schema/blocks/attribution.schema';

const APP_ID = 'app_test';
const APP_BLOCK_ID = 'apb_test';
const APP_OWNER_USER_ID = 999;
const PURCHASER_ID = 100;

function fakeAttribution(over: Partial<BlockAttribution> = {}): BlockAttribution {
  return {
    appId: APP_ID,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'mbi_test123',
    scope: 'per_model_install',
    ...over,
  };
}

beforeEach(() => {
  mockDbRead.oauthClient.findUnique.mockReset();
  mockDbRead.blockBuzzAttribution.findUnique.mockReset();
  mockDbWrite.blockBuzzAttribution.create.mockReset();
  mockDbWrite.blockBuzzAttribution.updateMany.mockReset();
  mockLog.mockReset();

  mockDbRead.oauthClient.findUnique.mockResolvedValue({
    id: APP_ID,
    userId: APP_OWNER_USER_ID,
  });
  // Default create echoes back what the caller supplied (the service
  // selects a subset of columns; we return the same subset).
  mockDbWrite.blockBuzzAttribution.create.mockImplementation(
    async ({ data, select }: any) => {
      const result: any = {};
      for (const k of Object.keys(select)) result[k] = data[k] ?? null;
      return result;
    }
  );
});

describe('recordAttribution', () => {
  it('writes a pending row with publisher share for a per_model_install purchase', async () => {
    const result = await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_abc',
      buzzTransactionId: 'bt_abc',
      attribution: fakeAttribution(),
    });

    expect(result.written).toBe(true);
    expect(mockDbWrite.blockBuzzAttribution.create).toHaveBeenCalledOnce();
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;

    expect(dataArg.userId).toBe(PURCHASER_ID);
    expect(dataArg.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(dataArg.appId).toBe(APP_ID);
    expect(dataArg.status).toBe('pending');
    expect(dataArg.voidedReason).toBeNull();
    expect(dataArg.providerFeeCents).toBe(50);
    // net 950 * 20% = 190
    expect(dataArg.appOwnerShareCents).toBe(190);
    expect(dataArg.platformShareCents).toBe(760);
    expect(
      dataArg.providerFeeCents + dataArg.platformShareCents + dataArg.appOwnerShareCents
    ).toBe(1000);
    expect(dataArg.rateCardVersion).toBe('v1');
    expect(dataArg.id).toMatch(/^bba_/);
  });

  it('writes a voided self-purchase row with zero publisher share', async () => {
    const result = await recordAttribution({
      userId: APP_OWNER_USER_ID, // purchaser IS the app owner
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_self',
      attribution: fakeAttribution({ scope: 'viewer_personal' }),
    });

    expect(result.written).toBe(true);
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;
    expect(dataArg.status).toBe('voided');
    expect(dataArg.voidedReason).toBe('self_purchase');
    expect(dataArg.voidedAt).toBeInstanceOf(Date);
    expect(dataArg.appOwnerShareCents).toBe(0);
    expect(dataArg.platformShareCents).toBe(950);
    // Civitai still keeps 100% (minus fee) — the row exists for audit.
    expect(dataArg.providerFeeCents + dataArg.platformShareCents).toBe(1000);
  });

  it('respects scope when calculating the share (viewer_personal earns more)', async () => {
    await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_viewer',
      attribution: fakeAttribution({ scope: 'viewer_personal' }),
    });
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;
    // net 950 * 25% = 237 (Math.floor)
    expect(dataArg.appOwnerShareCents).toBe(237);
    expect(dataArg.platformShareCents).toBe(713);
  });

  it('zeroes publisher share for platform_default scope', async () => {
    await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_default',
      attribution: fakeAttribution({ scope: 'platform_default' }),
    });
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;
    expect(dataArg.appOwnerShareCents).toBe(0);
    expect(dataArg.status).toBe('pending');
  });

  it('returns the existing row on duplicate write (idempotency via P2002)', async () => {
    const existingRow = {
      id: 'bba_existing',
      status: 'pending' as const,
      appOwnerShareCents: 190,
      platformShareCents: 760,
      providerFeeCents: 50,
      rateCardVersion: 'v1',
      voidedReason: null,
    };
    mockDbWrite.blockBuzzAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('Unique constraint failed', 'P2002')
    );
    mockDbRead.blockBuzzAttribution.findUnique.mockResolvedValueOnce(existingRow);

    const result = await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_dupe',
      attribution: fakeAttribution(),
    });

    expect(result.written).toBe(false);
    expect(result.row.id).toBe('bba_existing');
    expect(mockDbRead.blockBuzzAttribution.findUnique).toHaveBeenCalledWith({
      where: {
        paymentTransactionId_appBlockId: {
          paymentTransactionId: 'pi_dupe',
          appBlockId: APP_BLOCK_ID,
        },
      },
      select: expect.any(Object),
    });
  });

  it('rethrows non-unique-constraint Prisma errors', async () => {
    const otherErr = new FakePrismaKnownError('something else', 'P2003');
    mockDbWrite.blockBuzzAttribution.create.mockRejectedValueOnce(otherErr);

    await expect(
      recordAttribution({
        userId: PURCHASER_ID,
        buzzAmount: 5000,
        usdAmountCents: 1000,
        providerFeeCents: 50,
        paymentProvider: 'stripe',
        paymentTransactionId: 'pi_xx',
        attribution: fakeAttribution(),
      })
    ).rejects.toBe(otherErr);
  });

  it('throws AttributionAppMissingError when the OauthClient is gone', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValueOnce(null);
    await expect(
      recordAttribution({
        userId: PURCHASER_ID,
        buzzAmount: 5000,
        usdAmountCents: 1000,
        providerFeeCents: 50,
        paymentProvider: 'stripe',
        paymentTransactionId: 'pi_missing',
        attribution: fakeAttribution({ appId: 'app_deleted' }),
      })
    ).rejects.toBeInstanceOf(AttributionAppMissingError);
    expect(mockDbWrite.blockBuzzAttribution.create).not.toHaveBeenCalled();
  });

  it('flows buzzTransactionId + modelId through to the row', async () => {
    await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 500,
      providerFeeCents: 0,
      paymentProvider: 'paddle',
      paymentTransactionId: 'paddle_tx_1',
      buzzTransactionId: 'buzz_tx_99',
      attribution: fakeAttribution({ modelId: 12345 }),
    });
    const dataArg = mockDbWrite.blockBuzzAttribution.create.mock.calls[0][0].data;
    expect(dataArg.buzzTransactionId).toBe('buzz_tx_99');
    expect(dataArg.modelId).toBe(12345);
    expect(dataArg.paymentProvider).toBe('paddle');
  });

  it('writes an audit log line on every successful attribution', async () => {
    await recordAttribution({
      userId: PURCHASER_ID,
      buzzAmount: 5000,
      usdAmountCents: 1000,
      providerFeeCents: 50,
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_audit',
      attribution: fakeAttribution(),
    });
    const audit = mockLog.mock.calls.find((c) => c[0]?.message?.startsWith('attribution written'));
    expect(audit).toBeTruthy();
    expect(audit?.[0].name).toBe('block-buzz-attribution');
    expect(audit?.[0].type).toBe('info');
  });
});

describe('voidAttributionsForPayment', () => {
  it('voids matching pending/confirmed/paid_out rows with a refund reason', async () => {
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 1 });
    const count = await voidAttributionsForPayment({
      paymentProvider: 'stripe',
      paymentTransactionId: 'pi_refund',
      reason: 'refund',
    });
    expect(count).toBe(1);
    const args = mockDbWrite.blockBuzzAttribution.updateMany.mock.calls[0][0];
    expect(args.where.paymentProvider).toBe('stripe');
    expect(args.where.paymentTransactionId).toBe('pi_refund');
    expect(args.where.status.in).toEqual(['pending', 'confirmed', 'paid_out']);
    expect(args.data.status).toBe('voided');
    expect(args.data.voidedReason).toBe('refund');
    expect(args.data.voidedAt).toBeInstanceOf(Date);
  });

  it('returns 0 (no log) when nothing matched', async () => {
    mockDbWrite.blockBuzzAttribution.updateMany.mockResolvedValueOnce({ count: 0 });
    const count = await voidAttributionsForPayment({
      paymentProvider: 'paddle',
      paymentTransactionId: 'paddle_unknown',
      reason: 'chargeback',
    });
    expect(count).toBe(0);
    const audit = mockLog.mock.calls.find((c) => c[0]?.message?.startsWith('voided'));
    expect(audit).toBeUndefined();
  });
});

describe('REFUND_WINDOWS_DAYS', () => {
  it('exposes the per-provider refund windows', () => {
    expect(REFUND_WINDOWS_DAYS.stripe).toBeGreaterThan(REFUND_WINDOWS_DAYS.paddle);
    expect(REFUND_WINDOWS_DAYS.paddle).toBeGreaterThan(REFUND_WINDOWS_DAYS.nowpayments);
  });
});
