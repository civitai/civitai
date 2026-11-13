import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createFakeBuzzLedger, insufficientFunds } from './buzz-ledger.fake';
import { createFakeAdvisoryLocks, settle } from './charge-lock.fake';

/**
 * A creator shop submission whose fee charge ends with an unknown outcome (the ledger committed,
 * the response was lost) must charge once across the creator's retry, continue to the listing when
 * a resend under the same id answers, and never list a second submission on one fee. Item and
 * pack share one fee path; both are driven here against a fake ledger with the service's
 * external-id semantics.
 */

const { mocks, buzz } = vi.hoisted(() => ({
  mocks: {
    keyValueFindUnique: vi.fn(),
    cosmeticCreate: vi.fn(),
    shopItemCreate: vi.fn(),
    packMemberCreate: vi.fn(),
    shopItemFindMany: vi.fn(),
    sharpMetadata: vi.fn(),
  },
  buzz: {
    createBuzzTransaction: vi.fn(),
    resendBuzzTransaction: vi.fn(),
    getTransactionByExternalId: vi.fn(),
    refundTransaction: vi.fn(),
  },
}));

dbMock.dbRead.cosmeticShopItem.findMany.mockImplementation((...args: unknown[]) =>
  (mocks.shopItemFindMany as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.keyValue.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.keyValueFindUnique as (...a: unknown[]) => unknown)(...args)
);
// Every transaction goes through the fake advisory locks, so two requests with one key serialise
// the way they do on the primary.
let locks = createFakeAdvisoryLocks();
dbMock.dbWrite.$transaction.mockImplementation(((cb: (tx: unknown) => Promise<unknown>) =>
  locks.transaction(cb, {
    cosmetic: { create: mocks.cosmeticCreate },
    cosmeticShopItem: {
      create: mocks.shopItemCreate,
      findFirst: (args: unknown) => dbMock.dbWrite.cosmeticShopItem.findFirst(args as never),
    },
    cosmeticShopItemCosmetic: { createMany: mocks.packMemberCreate },
  })) as never);

vi.mock('sharp', () => ({ default: () => ({ metadata: mocks.sharpMetadata }) }));
vi.mock('~/server/services/buzz.service', () => buzz);
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

const { submitCreatorShopItem } = await import('../creator-shop.service');
const { submitCreatorShopPack } = await import('../creator-shop-pack.service');
// Literal, not imported: the user-facing contract, and importable where the module is absent.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Trying this same action again from this page is safe. If you reloaded or left the page, check your Buzz balance and transactions first.";
const ALREADY_COMPLETED =
  'This submission was already completed. Reload to see it, or start a new submission.';
const PAYMENT_REFUNDED_MESSAGE = 'The payment for this attempt was refunded. Please try again.';
const fees = await import('../creator-shop-fees.service');
const submissionFeeTransactionId = (...a: Parameters<typeof fees.submissionFeeTransactionId>) =>
  fees.submissionFeeTransactionId(...a);

const USER = 11;
const KEY = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const OTHER_KEY = '0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b';
const ART_KEY = '1a2b3c4d-0000-4000-8000-0000000000bb';
const ITEM_FEE = 10000;
const PACK_FEE = 1000;
const members = [1, 2];

const sites = [
  {
    kind: 'item',
    fee: ITEM_FEE,
    submit: (extra: { idempotencyKey?: string; userId?: number; name?: string } = {}) =>
      submitCreatorShopItem({
        userId: USER,
        cosmeticType: CosmeticType.Badge,
        name: 'Golden Laurel',
        description: null,
        imageUrl: ART_KEY,
        price: 500,
        availableQuantity: null,
        buzzType: 'yellow',
        sellableByOthers: false,
        sellerShare: 0,
        acceptsBlueBuzz: false,
        rightsAffirmed: true,
        quotedFee: ITEM_FEE,
        ...extra,
      }),
  },
  {
    kind: 'pack',
    fee: PACK_FEE,
    submit: (extra: { idempotencyKey?: string; userId?: number; name?: string } = {}) =>
      submitCreatorShopPack({
        userId: USER,
        name: 'Laurels',
        description: null,
        price: 1000,
        availableQuantity: null,
        buzzType: 'yellow',
        acceptsBlueBuzz: false,
        memberCosmeticIds: members,
        quotedFee: PACK_FEE,
        ...extra,
      }),
  },
] as const;

let ledger: ReturnType<typeof createFakeBuzzLedger>;
const listedTxIds = new Set<string>();
let clock = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.sysRedis.mGet.mockResolvedValue([String(USER)] as never);
  mocks.keyValueFindUnique.mockResolvedValue(null);
  mocks.sharpMetadata.mockResolvedValue({
    width: 144,
    height: 144,
    format: 'png',
    hasAlpha: true,
    pages: 1,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(8),
    })
  );
  mocks.cosmeticCreate.mockResolvedValue({ id: 99 });
  // Listings record their fee's transaction; the reused-key check reads them back from there.
  listedTxIds.clear();
  mocks.shopItemCreate.mockImplementation(
    async (args: { data: { meta: { submissionTxId: string } } }) => {
      listedTxIds.add(args.data.meta.submissionTxId);
      return { id: listedTxIds.size };
    }
  );
  dbMock.dbWrite.cosmeticShopItem.findFirst.mockImplementation((async (args: {
    where: { meta: { path: string[]; equals: string } };
  }) =>
    args.where.meta.path.join('.') === 'submissionTxId' && listedTxIds.has(args.where.meta.equals)
      ? { id: 1 }
      : null) as never);
  // The artwork duplicate check reads no listings; the pack's member read returns its members.
  mocks.shopItemFindMany.mockImplementation(async (args: { where?: { cosmeticId?: unknown } }) =>
    args?.where?.cosmeticId
      ? members.map((id) => ({
          cosmeticId: id,
          unitAmount: 500,
          meta: { acceptsBlueBuzz: false },
          cosmetic: {
            id,
            name: `member ${id}`,
            type: CosmeticType.Badge,
            data: {},
            createdById: USER,
            creator: { username: 'me' },
          },
        }))
      : []
  );

  // Reset, not just cleared: a once-queued answer a test never reached must not leak.
  for (const fn of Object.values(buzz)) fn.mockReset();
  ledger = createFakeBuzzLedger();
  locks = createFakeAdvisoryLocks();
  buzz.createBuzzTransaction.mockImplementation(ledger.createBuzzTransaction);
  buzz.resendBuzzTransaction.mockImplementation(ledger.resendBuzzTransaction);
  buzz.getTransactionByExternalId.mockImplementation(ledger.getTransactionByExternalId);
  buzz.refundTransaction.mockImplementation(ledger.refundTransaction);
  // Each attempt is a later moment, as it is for a creator pressing submit again.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
});

const submittedTxId = () => mocks.shopItemCreate.mock.calls[0][0].data.meta.submissionTxId;

describe.each(sites)('$kind submission fee across an unknown outcome', (site) => {
  it('a retry with the same key after an unanswered charge charges once and submits', async () => {
    // The charge and its resend both go unanswered: the creator is told it may have gone through.
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    // What the creator is told is pinned below; here only that it failed and created nothing.
    await expect(site.submit({ idempotencyKey: KEY })).rejects.toThrow();
    ledger.clearFaults();
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();

    await site.submit({ idempotencyKey: KEY });

    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0].amount).toBe(site.fee);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
    expect(submittedTxId()).toBe(ledger.charges()[0].transactionId);
  });

  it('continues to the listing in the same request when the resend answers', async () => {
    ledger.queueFault('lose-response');

    await site.submit({ idempotencyKey: KEY });

    expect(ledger.charges()).toHaveLength(1);
    expect(buzz.resendBuzzTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
    // The ledger's own id, answered to the resend for the charge the lost response carried.
    expect(submittedTxId()).toBe(ledger.charges()[0].transactionId);
  });

  it('charges once through the resend when the first send moved nothing', async () => {
    ledger.queueFault('fail-before-commit');

    await site.submit({ idempotencyKey: KEY });

    expect(ledger.charges()).toHaveLength(1);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
  });

  it('answers "may have gone through" when the resend also fails, and creates nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('fail-before-commit');

    const error = await site.submit({ idempotencyKey: KEY }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
  });

  it('passes a decline through unchanged, without a resend', async () => {
    buzz.createBuzzTransaction.mockRejectedValueOnce(insufficientFunds());

    await expect(site.submit({ idempotencyKey: KEY })).rejects.toThrow(/enough funds/);
    expect(buzz.resendBuzzTransaction).not.toHaveBeenCalled();
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();
  });

  it('refuses to reuse a charge that was refunded, so the client starts over', async () => {
    mocks.shopItemCreate.mockRejectedValueOnce(new Error('write failed'));
    await expect(site.submit({ idempotencyKey: KEY })).rejects.toThrow('write failed');
    expect(ledger.refunds()).toHaveLength(1);

    const error = await site.submit({ idempotencyKey: KEY }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: PAYMENT_REFUNDED_MESSAGE });
    expect(ledger.charges()).toHaveLength(1);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
  });

  // A listed submission whose response was lost, then the key sent again: for the same content (a
  // retry) or other content (a client that held the key too long). That fee paid for the first
  // listing; nothing is listed on it again.
  it.each([
    ['the same submission', {}],
    ['a different submission', { name: 'Another listing' }],
  ])('refuses a reused key whose charge is already listed: %s', async (_, other) => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await site.submit({ idempotencyKey: KEY }).catch(() => undefined);
    ledger.clearFaults();
    await site.submit({ idempotencyKey: KEY });
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);

    const error = await site.submit({ idempotencyKey: KEY, ...other }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'BAD_REQUEST', message: ALREADY_COMPLETED });
    expect(ledger.charges()).toHaveLength(1);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
  });

  it('a different submission after a lost response, under its own key, pays its own fee', async () => {
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await site.submit({ idempotencyKey: KEY }).catch(() => undefined);
    ledger.clearFaults();

    await site.submit({ idempotencyKey: OTHER_KEY, name: 'Another listing' });

    expect(ledger.charges()).toHaveLength(2);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
    expect(submittedTxId()).toBe(ledger.charges()[1].transactionId);
  });

  // The first charge landed and spent the balance; the retry is answered from it, not refused
  // as "insufficient funds" (a 400 the client reads as "nothing charged, start over").
  it('a retry whose balance the first charge spent continues from that charge', async () => {
    ledger.setBalance(USER, site.fee);
    ledger.queueFault('lose-response');
    ledger.queueFault('lose-response');
    await expect(site.submit({ idempotencyKey: KEY })).rejects.toThrow();
    ledger.clearFaults();
    expect(ledger.balanceOf(USER)).toBe(0);

    await site.submit({ idempotencyKey: KEY });

    expect(ledger.charges()).toHaveLength(1);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
    expect(submittedTxId()).toBe(ledger.charges()[0].transactionId);
  });

  it('a clean "insufficient funds" answer to the first send is the old 400', async () => {
    buzz.createBuzzTransaction.mockResolvedValueOnce({ transactionId: null });

    await expect(site.submit({ idempotencyKey: KEY })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Unable to charge the submission fee',
    });
    expect(buzz.resendBuzzTransaction).not.toHaveBeenCalled();
  });

  // Without the lookup there is no telling a retry whose charge landed from a fresh submission;
  // charging anyway could be a second charge.
  it('a lookup that fails before charging is "may have gone through", and charges nothing', async () => {
    ledger.failLookups();

    await expect(site.submit({ idempotencyKey: KEY })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: PAYMENT_OUTCOME_UNKNOWN_MESSAGE,
    });
    expect(ledger.charges()).toHaveLength(0);
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();
  });

  it('takes the lock on the fee charge id', async () => {
    await site.submit({ idempotencyKey: KEY });
    expect(locks.taken()).toEqual([submissionFeeTransactionId(site.kind, USER, KEY)]);
    // Every Buzz write under the lock has a deadline, so the lock cannot outlive a hung write.
    expect(buzz.createBuzzTransaction.mock.calls[0][1]).toEqual({ timeoutMs: 15_000 });
  });

  // A hung charge: the client times out and retries while the first request is still running.
  it('two requests with one key in flight: one charge, one listing', async () => {
    ledger.queueFault('hang');
    const first = site.submit({ idempotencyKey: KEY });
    await settle();
    const second = site.submit({ idempotencyKey: KEY }).catch((e: unknown) => e);
    await settle();
    ledger.releaseHung();

    await first;
    expect(await second).toMatchObject({ code: 'BAD_REQUEST', message: ALREADY_COMPLETED });
    expect(ledger.charges()).toHaveLength(1);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
  });

  it('the first request refund after a failed write never reverses a charge the second listed', async () => {
    let failWrite!: (error: Error) => void;
    mocks.shopItemCreate.mockImplementationOnce(
      () => new Promise((_, reject) => (failWrite = reject))
    );
    const first = site.submit({ idempotencyKey: KEY }).catch((e: unknown) => e);
    while (!failWrite) await settle();
    const second = site.submit({ idempotencyKey: KEY }).catch((e: unknown) => e);
    await settle();
    failWrite(new Error('write failed'));

    expect(await first).toMatchObject({ message: 'write failed' });
    expect(await second).toMatchObject({ code: 'BAD_REQUEST', message: PAYMENT_REFUNDED_MESSAGE });
    expect(ledger.refunds()).toHaveLength(1);
    expect(listedTxIds.size).toBe(0);
  });

  it('charges a new submission (a new key) again', async () => {
    await site.submit({ idempotencyKey: KEY });
    await site.submit({ idempotencyKey: OTHER_KEY, name: 'Another listing' });

    expect(ledger.charges()).toHaveLength(2);
  });
});

describe('submission fee charge ids', () => {
  it('are the same for one user and key, and differ by user, key and kind', () => {
    const id = submissionFeeTransactionId('item', USER, KEY);
    expect(id).toBe(`creator-shop-submit-${USER}-${KEY}`);
    expect(submissionFeeTransactionId('item', USER, KEY)).toBe(id);
    expect(submissionFeeTransactionId('item', USER + 1, KEY)).not.toBe(id);
    expect(submissionFeeTransactionId('item', USER, OTHER_KEY)).not.toBe(id);
    expect(submissionFeeTransactionId('pack', USER, KEY)).toBe(
      `creator-shop-pack-submit-${USER}-${KEY}`
    );
    expect(submissionFeeTransactionId('mysteryPack', USER, KEY)).toBe(
      `creator-shop-mystery-pack-submit-${USER}-${KEY}`
    );
  });

  it('is new per call without a key, as before keys', () => {
    expect(submissionFeeTransactionId('item', USER, undefined)).not.toBe(
      submissionFeeTransactionId('item', USER, undefined)
    );
  });
});
