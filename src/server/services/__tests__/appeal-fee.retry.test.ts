import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzService from '~/server/services/buzz.service';
import type * as PrefixRefund from '~/server/services/buzz-prefix-refund';
import { createFakeBuzzLedger } from './buzz-ledger.fake';
import { createFakeAdvisoryLocks, settle } from './charge-lock.fake';

/**
 * An appeal fee whose charge ends with an unknown outcome (the ledger committed, the response was
 * lost) must charge once across the user's retry, record the appeal once, and tell the user it may
 * have gone through when a resend cannot settle it. Driven against a fake ledger with the
 * multi-transaction endpoint's duplicate semantics.
 */

const { buzz, prefixRefund } = vi.hoisted(() => ({
  buzz: {
    createMultiAccountBuzzTransaction: vi.fn(),
    refundMultiAccountTransaction: vi.fn(),
    getMultiAccountTransactionsByPrefix: vi.fn(),
    getTransactionByExternalId: vi.fn(),
  },
  prefixRefund: { getPrefixRefundState: vi.fn() },
}));
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  ...buzz,
}));
vi.mock('~/server/services/buzz-prefix-refund', async (importOriginal) => ({
  ...(await importOriginal<typeof PrefixRefund>()),
  ...prefixRefund,
}));

import { createEntityAppeal } from '~/server/services/report.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Literal: the user-facing contract.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";
const PAYMENT_REFUNDED_MESSAGE = 'The payment for this attempt was refunded. Please try again.';
const USER = 31;
const IMAGE_ID = 4401;
const OTHER_IMAGE_ID = 4402;
const FEE = 100;
const KEY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_KEY = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const PREFIX = `appeal-k-${USER}-Image-${IMAGE_ID}-${KEY}`;

type AppealRow = { id: number; entityId: number; userId: number; buzzTransactionId: string | null };

let ledger: ReturnType<typeof createFakeBuzzLedger>;
let appeals: AppealRow[];
let locks = createFakeAdvisoryLocks();

const appeal = (idempotencyKey?: string, entityId = IMAGE_ID) =>
  createEntityAppeal({
    entityId,
    entityType: 'Image',
    message: 'This was removed by mistake',
    userId: USER,
    buzzType: 'yellow',
    idempotencyKey,
  });

beforeEach(() => {
  vi.clearAllMocks();
  // The fee is due: three recent pending or rejected appeals.
  dbMock.dbRead.appeal.count.mockResolvedValue(3);
  // The image is still appealable (its locked re-check updates one row).
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);

  appeals = [];
  dbMock.dbWrite.appeal.create.mockImplementation((async (args: {
    data: Omit<AppealRow, 'id'>;
  }) => {
    const row = { id: appeals.length + 1, ...args.data };
    appeals.push(row);
    return row;
  }) as never);
  dbMock.dbWrite.appeal.findFirst.mockImplementation(
    (async (args: { where: { userId: number; buzzTransactionId: string } }) =>
      appeals.find(
        (a) =>
          a.userId === args.where.userId && a.buzzTransactionId === args.where.buzzTransactionId
      ) ?? null) as never
  );

  locks = createFakeAdvisoryLocks();
  dbMock.dbWrite.$transaction.mockImplementation(((
    cb: (tx: unknown) => Promise<unknown>,
    options?: { timeout?: number }
  ) =>
    locks.transaction(
      cb,
      {
        $executeRaw: (...args: unknown[]) => dbMock.dbWrite.$executeRaw(...(args as [never])),
        appeal: {
          create: (args: unknown) => dbMock.dbWrite.appeal.create(args as never),
          findFirst: (args: unknown) => dbMock.dbWrite.appeal.findFirst(args as never),
        },
      },
      options
    )) as never);

  // Reset, not just cleared: a once-queued answer a test never reached must not leak.
  for (const fn of [...Object.values(buzz), ...Object.values(prefixRefund)]) fn.mockReset();
  ledger = createFakeBuzzLedger();
  buzz.createMultiAccountBuzzTransaction.mockImplementation(
    ledger.createMultiAccountBuzzTransaction
  );
  buzz.refundMultiAccountTransaction.mockImplementation(ledger.refundMultiAccountTransaction);
  buzz.getMultiAccountTransactionsByPrefix.mockImplementation(
    ledger.getMultiAccountTransactionsByPrefix
  );
  buzz.getTransactionByExternalId.mockImplementation(ledger.getTransactionByExternalId);
  prefixRefund.getPrefixRefundState.mockImplementation(ledger.getPrefixRefundState);
});

/** Enough lost answers to outlast any in-request retry of the charge. */
const loseEveryAnswer = () => {
  for (let i = 0; i < 6; i++) ledger.queueFault('lose-response');
};

describe('an appeal fee across an unknown outcome', () => {
  it('a retry with the same key after an unanswered charge charges once and records once', async () => {
    loseEveryAnswer();
    await expect(appeal(KEY)).rejects.toThrow();
    ledger.clearFaults();
    expect(appeals).toHaveLength(0);

    await appeal(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0].amount).toBe(FEE);
    expect(appeals).toHaveLength(1);
    expect(appeals[0].buzzTransactionId).toBe(PREFIX);
  });

  it('records the appeal in the same request when the resend answers', async () => {
    ledger.queueFault('lose-response');

    await appeal(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(2);
    expect(appeals).toHaveLength(1);
  });

  it('answers "may have gone through" when the resend also fails, and records nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('fail-before-commit');

    const error = await appeal(KEY).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(appeals).toHaveLength(0);
    expect(ledger.refunds()).toHaveLength(0);
  });

  it('a lookup that fails before charging is "may have gone through", and charges nothing', async () => {
    ledger.failLookups();

    await expect(appeal(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(buzz.createMultiAccountBuzzTransaction).not.toHaveBeenCalled();
    expect(ledger.charges()).toHaveLength(0);
    expect(appeals).toHaveLength(0);
  });

  it('a decline is not resent, and is a 400 so the client starts over', async () => {
    ledger.setBalance(USER, FEE - 1);

    await expect(appeal(KEY)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(buzz.createMultiAccountBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(appeals).toHaveLength(0);
  });

  // The first charge landed and spent the balance; the multi-transaction endpoint checks the
  // balance before it looks at ids, so only a lookup first can tell the retry its money moved.
  it('a retry whose balance the first charge spent records the appeal from that charge', async () => {
    ledger.setBalance(USER, FEE);
    loseEveryAnswer();
    await expect(appeal(KEY)).rejects.toThrow();
    ledger.clearFaults();
    expect(ledger.balanceOf(USER)).toBe(0);

    await appeal(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(appeals).toHaveLength(1);
  });

  // The ledger checks the balance before it looks at ids, so a retry whose lookup has not seen the
  // earlier charge yet is declined for the balance that charge spent. The charge is looked up
  // again before the decline stands: a 400 would release the client's key with the fee held.
  it('a retry declined for balance while its earlier charge is held continues from that charge', async () => {
    ledger.setBalance(USER, FEE);
    loseEveryAnswer();
    await expect(appeal(KEY)).rejects.toThrow();
    ledger.clearFaults();
    ledger.hideNextLookups(1);

    await appeal(KEY);

    expect(ledger.charges()).toHaveLength(1);
    expect(appeals).toHaveLength(1);
  });

  it('a retry after the appeal was recorded (response lost) answers with it and charges nothing more', async () => {
    const first = await appeal(KEY);

    const again = await appeal(KEY);

    expect(again).toEqual(first);
    expect(ledger.charges()).toHaveLength(1);
    expect(appeals).toHaveLength(1);
  });

  it('refuses to record a charge that was refunded, so the client starts over', async () => {
    dbMock.dbWrite.appeal.create.mockRejectedValueOnce(new Error('write failed'));
    await expect(appeal(KEY)).rejects.toThrow('write failed');
    expect(ledger.refunds()).toHaveLength(1);

    const error = await appeal(KEY).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: PAYMENT_REFUNDED_MESSAGE });
    expect(appeals).toHaveLength(0);
  });

  // Refused as soon as the replayed charge is seen to be refunded, before a transaction is opened.
  it('a retry on a refunded charge is refused without taking a database connection', async () => {
    dbMock.dbWrite.appeal.create.mockRejectedValueOnce(new Error('write failed'));
    await expect(appeal(KEY)).rejects.toThrow('write failed');
    dbMock.dbWrite.$transaction.mockClear();

    await expect(appeal(KEY)).rejects.toMatchObject({ message: PAYMENT_REFUNDED_MESSAGE });
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
  });

  // The user id in the prefix is what keeps one user's key from naming another user's fee.
  it("another user's request under the same key is charged on its own", async () => {
    await appeal(KEY);
    await createEntityAppeal({
      entityId: IMAGE_ID,
      entityType: 'Image',
      message: 'This was removed by mistake',
      userId: USER + 1,
      buzzType: 'yellow',
      idempotencyKey: KEY,
    });

    expect(ledger.charges().map((c) => c.fromAccountId)).toEqual([USER, USER + 1]);
    expect(appeals.map((a) => a.userId)).toEqual([USER, USER + 1]);
  });

  it('refuses to record a charge refunded while it waited for the lock', async () => {
    locks.onNextLock(async () => {
      await ledger.refundMultiAccountTransaction({ externalTransactionIdPrefix: PREFIX });
    });

    await expect(appeal(KEY)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: PAYMENT_REFUNDED_MESSAGE,
    });
    expect(appeals).toHaveLength(0);
  });

  it('refunds a failed record with one bounded attempt', async () => {
    dbMock.dbWrite.appeal.create.mockRejectedValueOnce(new Error('write failed') as never);

    await expect(appeal(KEY)).rejects.toThrow('write failed');

    expect(ledger.refunds()).toHaveLength(1);
    expect(buzz.refundMultiAccountTransaction.mock.calls[0][1]).toEqual({
      timeoutMs: 10_000,
      retries: 0,
    });
  });

  it('a concurrent submit that took the one pending slot is "already pending", and the fee is refunded', async () => {
    dbMock.dbWrite.appeal.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' })
    );

    await expect(appeal(KEY)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(ledger.refunds()).toHaveLength(1);
  });

  it('a new appeal (a new key) charges again', async () => {
    await appeal(KEY);
    await appeal(OTHER_KEY);

    expect(ledger.charges()).toHaveLength(2);
    expect(appeals).toHaveLength(2);
  });

  it('a key reused for a different entity is a different fee, charged on its own', async () => {
    loseEveryAnswer();
    await appeal(KEY).catch(() => undefined);
    ledger.clearFaults();

    await appeal(KEY, OTHER_IMAGE_ID);

    expect(ledger.charges()).toHaveLength(2);
    expect(appeals).toEqual([expect.objectContaining({ entityId: OTHER_IMAGE_ID })]);
  });

  // The ledger answers a held prefix with what it holds, whatever was sent: a retry under the same
  // key paying in another currency is not the charge it would reuse.
  it('a retry under the same key paying in another currency is refused, and records nothing', async () => {
    loseEveryAnswer();
    await expect(appeal(KEY)).rejects.toThrow();
    ledger.clearFaults();

    await expect(
      createEntityAppeal({
        entityId: IMAGE_ID,
        entityType: 'Image',
        message: 'This was removed by mistake',
        userId: USER,
        buzzType: 'green',
        idempotencyKey: KEY,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'This payment was already started with different details. Please start it again.',
    });
    expect(ledger.charges()).toHaveLength(1);
    expect(appeals).toHaveLength(0);
  });

  it('files the fee under the user, the entity, then the key', async () => {
    await appeal(KEY);
    expect(ledger.charges().map((c) => c.externalTransactionId)).toEqual([`${PREFIX}-0`]);
  });

  it('takes the lock on the fee prefix', async () => {
    await appeal(KEY);
    expect(locks.taken()).toEqual([PREFIX]);
  });

  // A slow Buzz service must not hold the app's write pool: the charge runs before the record's
  // transaction opens.
  it('holds no transaction while the Buzz charge is pending', async () => {
    ledger.queueFault('hang');
    const appealed = appeal(KEY);
    while (!ledger.isHung()) await settle();
    expect(locks.open()).toBe(0);
    expect(dbMock.dbWrite.$transaction).not.toHaveBeenCalled();
    ledger.releaseHung();
    await appealed;
    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(appeals).toHaveLength(1);
  });

  it('two requests with one key in flight: one charge, one appeal', async () => {
    ledger.queueFault('hang');
    const first = appeal(KEY);
    await settle();
    const second = appeal(KEY);
    await settle();
    ledger.releaseHung();
    const [a, b] = await Promise.all([first, second]);

    expect(ledger.charges()).toHaveLength(1);
    expect(appeals).toHaveLength(1);
    expect(a).toEqual(b);
  });

  it('no pooled connection for the record is "may have gone through", with no refund', async () => {
    dbMock.dbWrite.$transaction.mockImplementationOnce((() =>
      Promise.reject(
        new Prisma.PrismaClientKnownRequestError('pool', { code: 'P2024', clientVersion: 'test' })
      )) as never);

    await expect(appeal(KEY)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(ledger.refunds()).toHaveLength(0);

    await appeal(KEY);
    expect(ledger.charges()).toHaveLength(1);
    expect(appeals).toHaveLength(1);
  });
});

describe('an appeal fee without a key', () => {
  it('is charged under a new prefix per call, as before', async () => {
    await appeal();
    await appeal();

    const ids = ledger.charges().map((c) => c.externalTransactionId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(new RegExp(`^appeal-${USER}-\\d+-[0-9a-f]{8}-0$`));
    expect(buzz.getMultiAccountTransactionsByPrefix).not.toHaveBeenCalled();
    expect(locks.taken()).toEqual([]);
  });
});
