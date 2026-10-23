import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The NOWPayments webhook runs into the real processDeposit. What it records and credits must be
 * NOWPayments' own record of the payment, and a redelivered payment must credit and notify once.
 */

const { caller, grantBuzzPurchase, signalSend, createNotification } = vi.hoisted(() => ({
  caller: { validateWebhookEvent: vi.fn(), getPaymentStatus: vi.fn() },
  grantBuzzPurchase: vi.fn(),
  signalSend: vi.fn(),
  createNotification: vi.fn(),
}));

vi.mock('~/env/server', () => ({
  env: { NOW_PAYMENTS_IPN_KEY: 'ipn-secret', NEXTAUTH_URL: 'https://civitai.test', LOGGING: '' },
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  trackWebhookEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({ default: caller }));
vi.mock('~/server/services/buzz.service', () => ({
  grantBuzzPurchase,
  getTransactionByExternalId: vi.fn(async () => null),
  getMultipliersForUser: vi.fn(async () => ({ purchasesMultiplier: 1 })),
}));
vi.mock('~/server/services/referral.service', () => ({
  recordBuzzPurchaseKickback: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: signalSend } }));

const handler = (await import('~/pages/api/webhooks/nowpayments')).default;

const PAYMENT_ID = 12345;

const apiPayment = (over: Record<string, unknown> = {}) => ({
  payment_id: PAYMENT_ID,
  payment_status: 'finished',
  order_id: 'user:42',
  outcome_amount: 9.5,
  actually_paid: 10,
  pay_currency: 'btc',
  pay_address: '0xaddr',
  payin_hash: '0xhash',
  ...over,
});

const ipn = (over: Record<string, unknown> = {}) => ({
  payment_id: PAYMENT_ID,
  payment_status: 'finished',
  order_id: 'user:42',
  outcome_amount: 9.5,
  actually_paid: 10,
  pay_currency: 'btc',
  pay_address: '0xaddr',
  fee: { currency: 'usdc', depositFee: '0.1', serviceFee: '0.2', withdrawalFee: '0' },
  ...over,
});

async function deliver(body: unknown) {
  const req = { method: 'POST', headers: { 'x-nowpayments-sig': 'sig' }, body };
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: () => res,
    send: () => res,
    setHeader: () => res,
    end: () => res,
    _status: () => statusCode,
  };
  await handler(req as never, res as never);
  return res;
}

const deposits = new Map<bigint, Record<string, unknown>>();
const grantedIds = new Set<string>();

beforeEach(() => {
  vi.clearAllMocks();
  deposits.clear();
  grantedIds.clear();
  caller.validateWebhookEvent.mockReset().mockReturnValue({ isValid: true });
  caller.getPaymentStatus.mockReset().mockResolvedValue(apiPayment());
  signalSend.mockReset().mockResolvedValue(undefined);
  createNotification.mockReset().mockResolvedValue(undefined);
  // The Buzz service refuses a second transaction with the same external id.
  grantBuzzPurchase.mockReset().mockImplementation(async ({ externalTransactionId }) => {
    if (grantedIds.has(externalTransactionId))
      throw new Error('There is a conflict with the transaction');
    grantedIds.add(externalTransactionId);
    return `tx-${grantedIds.size}`;
  });
  dbMock.dbRead.cryptoWallet.findUnique.mockResolvedValue({ chain: 'evm' });
  dbMock.dbRead.cryptoDeposit.findUnique.mockImplementation(
    async ({ where }: { where: { paymentId: bigint } }) => deposits.get(where.paymentId) ?? null
  );
  dbMock.dbWrite.cryptoDeposit.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { paymentId: bigint };
      create: any;
      update: any;
    }) => {
      const row = deposits.has(where.paymentId)
        ? { ...deposits.get(where.paymentId), ...update }
        : create;
      deposits.set(where.paymentId, row);
      return row;
    }
  );
});

describe('nowpayments webhook: the payment comes from NOWPayments', () => {
  it('answers 400 and records nothing when NOWPayments has no such payment', async () => {
    caller.getPaymentStatus.mockResolvedValue(null);

    const res = await deliver(ipn());

    expect(res._status()).toBe(400);
    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.cryptoDeposit.upsert).not.toHaveBeenCalled();
    expect(signalSend).not.toHaveBeenCalled();
  });

  it('credits the owner and amount NOWPayments reports, not the ones in the request', async () => {
    const res = await deliver(ipn({ order_id: 'user:99', outcome_amount: 500 }));

    expect(res._status()).toBe(200);
    expect(grantBuzzPurchase).toHaveBeenCalledTimes(1);
    expect(grantBuzzPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, amount: 9500 })
    );
    expect(deposits.get(BigInt(PAYMENT_ID))).toMatchObject({
      userId: 42,
      outcomeAmount: 9.5,
      depositFee: null,
    });
    expect(signalSend.mock.calls.map(([call]) => call.userId)).toEqual([42]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'warning',
        stage: 'payment-mismatch',
        paymentId: PAYMENT_ID,
        fields: ['order_id', 'outcome_amount'],
      })
    );
  });

  it('records the owner NOWPayments reports for a payment still confirming', async () => {
    caller.getPaymentStatus.mockResolvedValue(
      apiPayment({ payment_status: 'confirming', outcome_amount: null })
    );

    await deliver(ipn({ payment_status: 'confirming', order_id: 'user:99' }));

    expect(deposits.get(BigInt(PAYMENT_ID))).toMatchObject({ userId: 42, status: 'confirming' });
    expect(signalSend.mock.calls.map(([call]) => call.userId)).toEqual([42]);
  });

  it.each([
    ['NOWPayments does not report it as paid yet', { payment_status: 'confirming' }],
    ['NOWPayments reports it as paid without an amount', { outcome_amount: null }],
    ['NOWPayments returns a different payment', { payment_id: 54321 }],
  ])('asks for redelivery, and credits nothing, when %s', async (_case, over) => {
    caller.getPaymentStatus.mockResolvedValue(apiPayment(over));

    const res = await deliver(ipn());

    expect(res._status()).toBe(400);
    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.cryptoDeposit.upsert).not.toHaveBeenCalled();
    expect(signalSend).not.toHaveBeenCalled();
  });

  it('records the fees a matching request carries', async () => {
    await deliver(ipn());

    expect(deposits.get(BigInt(PAYMENT_ID))).toMatchObject({ depositFee: 0.1, serviceFee: 0.2 });
  });

  it('tells the user when a confirming deposit is paid', async () => {
    caller.getPaymentStatus.mockResolvedValueOnce(
      apiPayment({ payment_status: 'confirming', outcome_amount: null })
    );
    await deliver(ipn({ payment_status: 'confirming' }));
    await deliver(ipn());

    expect(signalSend.mock.calls.map(([call]) => call.data.status)).toEqual([
      'confirming',
      'finished',
    ]);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('tells the user when a confirming deposit fails', async () => {
    caller.getPaymentStatus
      .mockResolvedValueOnce(apiPayment({ payment_status: 'confirming', outcome_amount: null }))
      .mockResolvedValueOnce(apiPayment({ payment_status: 'failed', outcome_amount: null }));
    await deliver(ipn({ payment_status: 'confirming' }));
    await deliver(ipn({ payment_status: 'failed' }));

    expect(signalSend.mock.calls.map(([call]) => call.data.status)).toEqual([
      'confirming',
      'failed',
    ]);
  });

  it('tells the user when a deposit already marked finished is credited late', async () => {
    deposits.set(BigInt(PAYMENT_ID), { status: 'finished', userId: 42, buzzCredited: null });

    await deliver(ipn());

    expect(grantedIds).toEqual(new Set([`np-deposit-${PAYMENT_ID}`]));
    expect(signalSend).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('credits, signals and notifies once when the same payment is delivered twice', async () => {
    const first = await deliver(ipn());
    const second = await deliver(ipn());

    expect([first._status(), second._status()]).toEqual([200, 200]);
    expect(grantedIds).toEqual(new Set([`np-deposit-${PAYMENT_ID}`]));
    expect(signalSend).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});
