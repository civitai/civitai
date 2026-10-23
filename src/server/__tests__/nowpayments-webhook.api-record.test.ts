import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The NOWPayments webhook runs into the real processDeposit and the real retry sweep. What they
 * record and credit must be NOWPayments' own record of the payment; a paid IPN NOWPayments cannot
 * confirm yet waits for the sweep, credited to no one and shown to no one; and a payment delivered
 * again must credit and notify once.
 */

const { caller, grantBuzzPurchase, getTransactionByExternalId, signalSend, createNotification } =
  vi.hoisted(() => ({
    caller: { validateWebhookEvent: vi.fn(), getPaymentStatus: vi.fn(), lookupPayment: vi.fn() },
    grantBuzzPurchase: vi.fn(),
    getTransactionByExternalId: vi.fn(),
    signalSend: vi.fn(),
    createNotification: vi.fn(),
  }));

vi.mock('~/env/server', () => ({
  env: {
    NOW_PAYMENTS_IPN_KEY: 'ipn-secret',
    NEXTAUTH_URL: 'https://civitai.test',
    LOGGING: '',
    NOWPAYMENTS_SUPPORT_EMAIL: 'support@nowpayments.test',
  },
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  trackWebhookEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/http/nowpayments/nowpayments.caller', () => ({ default: caller }));
vi.mock('~/server/services/buzz.service', () => ({
  grantBuzzPurchase,
  getTransactionByExternalId,
  getMultipliersForUser: vi.fn(async () => ({ purchasesMultiplier: 1 })),
}));
vi.mock('~/server/services/referral.service', () => ({
  recordBuzzPurchaseKickback: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification }));
vi.mock('~/utils/signal-client', () => ({ signalClient: { send: signalSend } }));

const handler = (await import('~/pages/api/webhooks/nowpayments')).default;
const { retryFailedDeposits, getDepositHistory } = await import(
  '~/server/services/nowpayments.service'
);
const { notifyStuckCryptoDepositsJob } = await import('~/server/jobs/notify-stuck-crypto-deposits');

const PAYMENT_ID = 12345;
const ROW = BigInt(PAYMENT_ID);

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

// An in-memory CryptoDeposit table answering the filters the code under test uses.
type Row = Record<string, any>;
const deposits = new Map<bigint, Row>();
const grantedIds = new Set<string>();

const matches = (row: Row, where: Record<string, any> = {}) =>
  Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond === null) return value == null;
    if (typeof cond !== 'object' || typeof cond === 'bigint') return value === cond;
    if ('in' in cond && !cond.in.includes(value)) return false;
    if ('notIn' in cond && cond.notIn.includes(value)) return false;
    if ('lt' in cond && !(value < cond.lt)) return false;
    if ('gte' in cond && !(value >= cond.gte)) return false;
    const known = ['in', 'notIn', 'lt', 'gte'];
    if (Object.keys(cond).some((op) => !known.includes(op))) throw new Error(`fake: ${key}`);
    return true;
  });
const applyData = (row: Row, data: Row) => {
  for (const [key, value] of Object.entries(data)) {
    row[key] =
      value && typeof value === 'object' && 'increment' in value
        ? (row[key] ?? 0) + value.increment
        : value;
  }
};
const seed = (row: Row) =>
  deposits.set(row.paymentId, {
    retryCount: 0,
    createdAt: new Date(),
    stuckNotifiedAt: null,
    ...row,
  });

beforeEach(() => {
  vi.clearAllMocks();
  deposits.clear();
  grantedIds.clear();
  caller.validateWebhookEvent.mockReset().mockReturnValue({ isValid: true });
  caller.getPaymentStatus.mockReset().mockResolvedValue(apiPayment());
  // The webhook's lookup answers what getPaymentStatus would, plus the HTTP status of a miss.
  caller.lookupPayment.mockReset().mockImplementation(async (id: number) => {
    const payment = await caller.getPaymentStatus(id);
    return { payment, status: payment ? 200 : 404 };
  });
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
  // Reads return copies, as Prisma does, so a caller holding a row sees no later writes.
  const findUnique = async ({ where }: { where: { paymentId: bigint } }) => {
    const row = deposits.get(where.paymentId);
    return row ? structuredClone(row) : null;
  };
  dbMock.dbRead.cryptoDeposit.findUnique.mockImplementation(findUnique);
  dbMock.dbWrite.cryptoDeposit.findUnique.mockImplementation(findUnique);
  getTransactionByExternalId.mockReset().mockResolvedValue(null);
  dbMock.dbRead.cryptoDeposit.findMany.mockImplementation(
    async ({ where, take }: { where: Row; take?: number }) =>
      [...deposits.values()]
        .filter((row) => matches(row, where))
        .slice(0, take)
        .map((row) => structuredClone(row))
  );
  dbMock.dbRead.cryptoDeposit.count.mockImplementation(
    async ({ where }: { where: Row }) =>
      [...deposits.values()].filter((r) => matches(r, where)).length
  );
  dbMock.dbWrite.cryptoDeposit.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { paymentId: bigint };
      create: Row;
      update: Row;
    }) => {
      const existing = deposits.get(where.paymentId);
      if (existing) applyData(existing, update);
      else seed(create);
      return deposits.get(where.paymentId);
    }
  );
  dbMock.dbWrite.cryptoDeposit.updateMany.mockImplementation(
    async ({ where, data }: { where: Row; data: Row }) => {
      const hit = [...deposits.values()].filter((row) => matches(row, where));
      hit.forEach((row) => applyData(row, data));
      return { count: hit.length };
    }
  );
  dbMock.dbWrite.cryptoDeposit.update.mockImplementation(
    async ({ where, data }: { where: { paymentId: bigint }; data: Row }) => {
      const row = deposits.get(where.paymentId)!;
      applyData(row, data);
      return row;
    }
  );
});

describe('nowpayments webhook: the payment comes from NOWPayments', () => {
  it('credits the owner and amount NOWPayments reports, not the ones in the request', async () => {
    const res = await deliver(ipn({ order_id: 'user:99', outcome_amount: 500 }));

    expect(res._status()).toBe(200);
    expect(grantBuzzPurchase).toHaveBeenCalledTimes(1);
    expect(grantBuzzPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, amount: 9500 })
    );
    expect(deposits.get(ROW)).toMatchObject({ userId: 42, outcomeAmount: 9.5, depositFee: null });
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

    expect(deposits.get(ROW)).toMatchObject({ userId: 42, status: 'confirming' });
    expect(signalSend.mock.calls.map(([call]) => call.userId)).toEqual([42]);
  });

  it('takes no fees or fiat value from the notification', async () => {
    await deliver(ipn({ actually_paid_at_fiat: 10 }));

    expect(deposits.get(ROW)).toMatchObject({ depositFee: null, serviceFee: null, paidFiat: null });
  });

  it('spends no lookup on a deposit already credited', async () => {
    seed({
      paymentId: ROW,
      userId: 42,
      status: 'finished',
      payCurrency: 'btc',
      buzzCredited: 9500,
    });

    const res = await deliver(ipn());

    expect(res._status()).toBe(200);
    expect(caller.lookupPayment).not.toHaveBeenCalled();
    expect(deposits.get(ROW)).toMatchObject({ status: 'finished', buzzCredited: 9500 });
    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(signalSend).not.toHaveBeenCalled();
  });

  it.each([
    [{ payment_status: 'finished' }, { outcome_amount: null }],
    [
      { payment_status: 'partially_paid' },
      { payment_status: 'partially_paid', outcome_amount: null },
    ],
    [{ payment_status: 'confirming' }, { outcome_amount: 0 }],
  ])(
    'leaves a payment NOWPayments reports paid without an amount to the sweep (%o, %o)',
    async (ipnOver, apiOver) => {
      caller.getPaymentStatus.mockResolvedValue(apiPayment(apiOver));

      await deliver(ipn(ipnOver));

      expect(grantBuzzPurchase).not.toHaveBeenCalled();
      expect(deposits.get(ROW)).toMatchObject({ status: 'buzz_failed', userId: 42 });
      expect(signalSend).not.toHaveBeenCalled();
    }
  );
});

describe('nowpayments webhook: a paid IPN NOWPayments cannot confirm yet', () => {
  it.each([
    ['NOWPayments has no such payment', {}, null],
    ['NOWPayments does not report it as paid yet', {}, { payment_status: 'confirming' }],
    [
      'NOWPayments does not report a partial payment as paid yet',
      { payment_status: 'partially_paid' },
      { payment_status: 'confirming' },
    ],
    ['NOWPayments returns a different payment', {}, { payment_id: 54321 }],
  ])(
    'asks for redelivery and leaves an unverified row when %s',
    async (_case, ipnOver, apiOver) => {
      caller.getPaymentStatus.mockResolvedValue(apiOver && apiPayment(apiOver));

      const res = await deliver(ipn({ order_id: 'user:99', ...ipnOver }));

      expect(res._status()).toBe(400);
      expect(grantBuzzPurchase).not.toHaveBeenCalled();
      expect(signalSend).not.toHaveBeenCalled();
      expect(createNotification).not.toHaveBeenCalled();
      expect(deposits.get(ROW)).toMatchObject({ status: 'unverified', userId: 99 });
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          stage: 'payment-verify-unavailable',
          paymentId: PAYMENT_ID,
        })
      );
    }
  );

  it.each([
    [404, 'not-found'],
    [500, 'lookup-failed-500'],
  ])('says why a lookup answered %i came back empty', async (status, reason) => {
    caller.lookupPayment.mockResolvedValue({ payment: null, status });

    await deliver(ipn());

    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'payment-verify-unavailable', reason })
    );
    expect(deposits.get(ROW)).toMatchObject({ status: 'unverified' });
  });

  it('leaves a deposit marked finished without credit as it is while the lookup is down', async () => {
    seed({
      paymentId: ROW,
      userId: 42,
      status: 'finished',
      payCurrency: 'btc',
      buzzCredited: null,
    });
    caller.getPaymentStatus.mockResolvedValue(null);

    await deliver(ipn());

    expect(deposits.get(ROW)).toMatchObject({ status: 'finished' });
  });

  it('hands the sweep a deposit another delivery creates while this one records it', async () => {
    caller.getPaymentStatus.mockResolvedValue(apiPayment({ payment_status: 'confirming' }));
    const upsert = dbMock.dbWrite.cryptoDeposit.upsert.getMockImplementation()!;
    dbMock.dbWrite.cryptoDeposit.upsert.mockImplementationOnce(async (args: never) => {
      seed({ paymentId: ROW, userId: 42, status: 'confirming', payCurrency: 'btc' });
      return upsert(args);
    });

    await deliver(ipn());
    expect(deposits.get(ROW)).toMatchObject({ status: 'buzz_failed', userId: 42 });

    caller.getPaymentStatus.mockResolvedValue(apiPayment());
    await retryFailedDeposits();
    expect(deposits.get(ROW)).toMatchObject({ status: 'finished' });
    expect(grantBuzzPurchase).toHaveBeenCalledTimes(1);
  });

  it('keeps a paid claim on the sweep when a verified confirming IPN follows it', async () => {
    caller.getPaymentStatus.mockResolvedValue(apiPayment({ payment_status: 'confirming' }));
    await deliver(ipn({ order_id: 'user:99' }));
    await deliver(ipn({ payment_status: 'confirming', order_id: 'user:99' }));
    expect(deposits.get(ROW)).toMatchObject({ status: 'unverified', userId: 42 });

    caller.getPaymentStatus.mockResolvedValue(apiPayment());
    await retryFailedDeposits();
    expect(deposits.get(ROW)).toMatchObject({ status: 'finished', userId: 42 });
    expect(grantBuzzPurchase).toHaveBeenCalledTimes(1);
  });

  it('writes nothing for a confirming IPN NOWPayments cannot find', async () => {
    caller.getPaymentStatus.mockResolvedValue(null);

    const res = await deliver(ipn({ payment_status: 'confirming' }));

    expect(res._status()).toBe(400);
    expect(deposits.size).toBe(0);
  });

  it.each(['confirming', 'failed'])(
    'hands a %s deposit NOWPayments already confirmed to the sweep without changing its owner',
    async (status) => {
      seed({ paymentId: ROW, userId: 42, status, payCurrency: 'btc', retryCount: 5 });
      caller.getPaymentStatus.mockResolvedValue(null);

      await deliver(ipn({ order_id: 'user:99' }));

      expect(deposits.get(ROW)).toMatchObject({ status: 'buzz_failed', userId: 42, retryCount: 0 });
    }
  );

  it('keeps a redelivered unconfirmed IPN unverified', async () => {
    caller.getPaymentStatus.mockResolvedValue(null);

    await deliver(ipn({ order_id: 'user:99' }));
    await deliver(ipn({ order_id: 'user:99' }));

    expect(deposits.get(ROW)).toMatchObject({ status: 'unverified', userId: 99 });
  });

  it('treats a lookup that fails outright like one that finds nothing', async () => {
    caller.getPaymentStatus.mockRejectedValue(new Error('socket hang up'));

    const res = await deliver(ipn({ order_id: 'user:99' }));

    expect(res._status()).toBe(400);
    expect(deposits.get(ROW)).toMatchObject({ status: 'unverified' });
  });

  it('shows the unverified row to no one', async () => {
    caller.getPaymentStatus.mockResolvedValue(null);
    await deliver(ipn({ order_id: 'user:99' }));
    seed({ paymentId: 777n, userId: 99, status: 'buzz_failed', payCurrency: 'btc' });
    seed({ paymentId: 778n, userId: 99, status: 'unverified_exhausted', payCurrency: 'btc' });

    const history = await getDepositHistory(99);
    caller.getPaymentStatus.mockClear();
    await notifyStuckCryptoDepositsJob.run({}).result;

    expect(history.deposits.map((d) => d.paymentId)).toEqual([777]);
    expect(history.total).toBe(1);
    // The stuck-deposit notifier looks up the verified row only.
    expect(caller.getPaymentStatus.mock.calls.map(([id]) => String(id))).toEqual(['777']);
  });

  it('credits the owner NOWPayments reports, once, when the sweep can confirm it later', async () => {
    caller.getPaymentStatus.mockResolvedValue(null);
    await deliver(ipn({ order_id: 'user:99', outcome_amount: 500 }));

    caller.getPaymentStatus.mockResolvedValue(apiPayment());
    await retryFailedDeposits();
    await deliver(ipn({ order_id: 'user:99', outcome_amount: 500 }));
    await retryFailedDeposits();

    expect(grantedIds).toEqual(new Set([`np-deposit-${PAYMENT_ID}`]));
    expect(grantBuzzPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, amount: 9500 })
    );
    expect(deposits.get(ROW)).toMatchObject({ status: 'finished', userId: 42, buzzCredited: 9500 });
    expect(signalSend.mock.calls.map(([call]) => call.userId)).toEqual([42]);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('credits nothing when the sweep is answered with a different payment', async () => {
    caller.getPaymentStatus.mockResolvedValue(null);
    await deliver(ipn({ order_id: 'user:99' }));

    caller.getPaymentStatus.mockResolvedValue(apiPayment({ payment_id: 54321 }));
    await retryFailedDeposits();

    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(deposits.get(ROW)).toMatchObject({ status: 'unverified', retryCount: 1 });
  });

  it('counts a retry when the sweep finds the payment paid without an amount', async () => {
    caller.getPaymentStatus.mockResolvedValue(null);
    await deliver(ipn({ order_id: 'user:99' }));

    caller.getPaymentStatus.mockResolvedValue(apiPayment({ outcome_amount: null }));
    await retryFailedDeposits();

    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(deposits.get(ROW)).toMatchObject({ status: 'buzz_failed', userId: 42, retryCount: 1 });
  });

  it('counts a retry when the sweep cannot write the confirmed deposit', async () => {
    caller.getPaymentStatus.mockResolvedValue(null);
    await deliver(ipn({ order_id: 'user:99' }));

    caller.getPaymentStatus.mockResolvedValue(apiPayment());
    dbMock.dbWrite.cryptoDeposit.upsert.mockRejectedValueOnce(new Error('write failed'));
    await retryFailedDeposits();

    expect(deposits.get(ROW)).toMatchObject({ status: 'unverified', retryCount: 1 });
  });

  it('leaves a deposit credited mid-sweep finished when the sweep gives up on it', async () => {
    seed({ paymentId: ROW, userId: 42, status: 'buzz_failed', payCurrency: 'btc', retryCount: 71 });
    caller.getPaymentStatus.mockImplementation(async () => {
      deposits.get(ROW)!.status = 'finished';
      return null;
    });

    await retryFailedDeposits();

    expect(deposits.get(ROW)).toMatchObject({ status: 'finished' });
  });

  it('retries an owed deposit however many unconfirmed claims are waiting', async () => {
    for (let id = 1; id <= 100; id++) {
      seed({ paymentId: BigInt(id), userId: 99, status: 'unverified', payCurrency: 'btc' });
    }
    seed({ paymentId: ROW, userId: 42, status: 'buzz_failed', payCurrency: 'btc' });
    caller.getPaymentStatus.mockResolvedValue(null);

    await retryFailedDeposits();

    const looked = caller.getPaymentStatus.mock.calls.map(([id]) => Number(id));
    expect(looked[0]).toBe(PAYMENT_ID);
    expect(looked.length).toBe(26);
    expect(deposits.get(ROW)).toMatchObject({ retryCount: 1 });
  });

  it('marks a confirmed deposit the sweep can no longer find as failed when it gives up', async () => {
    seed({ paymentId: ROW, userId: 42, status: 'buzz_failed', payCurrency: 'btc', retryCount: 71 });
    caller.getPaymentStatus.mockResolvedValue(null);

    await retryFailedDeposits();

    expect(deposits.get(ROW)).toMatchObject({ status: 'failed', userId: 42 });
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'payment-verify-exhausted' })
    );
  });

  it('never credits a payment NOWPayments never confirms, and says so when the sweep gives up', async () => {
    caller.getPaymentStatus.mockResolvedValue(null);
    await deliver(ipn({ order_id: 'user:99' }));
    deposits.get(ROW)!.retryCount = 71;

    await retryFailedDeposits();
    await retryFailedDeposits();

    expect(grantBuzzPurchase).not.toHaveBeenCalled();
    expect(signalSend).not.toHaveBeenCalled();
    expect(deposits.get(ROW)).toMatchObject({ status: 'unverified_exhausted', userId: 99 });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        stage: 'payment-verify-exhausted',
        paymentId: PAYMENT_ID,
      })
    );
  });
});

describe('nowpayments webhook: telling the user', () => {
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
    seed({
      paymentId: ROW,
      status: 'finished',
      userId: 42,
      buzzCredited: null,
      payCurrency: 'btc',
    });

    await deliver(ipn());

    expect(grantedIds).toEqual(new Set([`np-deposit-${PAYMENT_ID}`]));
    expect(signalSend).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('still notifies the user when the signal fails', async () => {
    signalSend.mockRejectedValueOnce(new Error('signal down'));

    const res = await deliver(ipn());

    expect(res._status()).toBe(200);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('does not credit again a deposit already credited by hand under the hash NOWPayments reports', async () => {
    getTransactionByExternalId.mockImplementation(async (id: string) =>
      id === 'np-payin-0xhash' ? { transactionId: 'manual' } : null
    );

    await deliver(ipn());

    expect(grantBuzzPurchase).not.toHaveBeenCalled();
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
