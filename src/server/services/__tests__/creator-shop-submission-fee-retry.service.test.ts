import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { createFakeBuzzLedger, insufficientFunds } from './buzz-ledger.fake';

/**
 * A creator shop submission whose fee charge ends with an unknown outcome (the ledger committed,
 * the response was lost) must charge once across the creator's retry, and must continue to the
 * item when the ledger shows the charge. Item and pack share one fee path; both are driven here
 * against a fake ledger with the service's external-id semantics.
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
    recoverBuzzTransactionId: vi.fn(),
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
dbMock.dbWrite.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
  cb({
    cosmetic: { create: mocks.cosmeticCreate },
    cosmeticShopItem: { create: mocks.shopItemCreate },
    cosmeticShopItemCosmetic: { createMany: mocks.packMemberCreate },
  })
);

vi.mock('sharp', () => ({ default: () => ({ metadata: mocks.sharpMetadata }) }));
vi.mock('~/server/services/buzz.service', () => buzz);
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));

const { submitCreatorShopItem } = await import('../creator-shop.service');
const { submitCreatorShopPack } = await import('../creator-shop-pack.service');
// Literal, not imported: the user-facing contract, and importable where the module is absent.
const PAYMENT_OUTCOME_UNKNOWN_MESSAGE =
  "We couldn't confirm whether your Buzz payment went through. Check your Buzz transactions before trying again. Retrying this same action will not charge you twice.";
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
    submit: (extra: { idempotencyKey?: string; userId?: number } = {}) =>
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
    submit: (extra: { idempotencyKey?: string; userId?: number } = {}) =>
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
  mocks.shopItemCreate.mockResolvedValue({ id: 1 });
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

  ledger = createFakeBuzzLedger();
  buzz.createBuzzTransaction.mockImplementation(ledger.createBuzzTransaction);
  buzz.recoverBuzzTransactionId.mockImplementation(ledger.recoverBuzzTransactionId);
  buzz.getTransactionByExternalId.mockImplementation(ledger.getTransactionByExternalId);
  buzz.refundTransaction.mockImplementation(ledger.refundTransaction);
  // Each attempt is a later moment, as it is for a creator pressing submit again.
  vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1000));
});

const submittedTxId = () => mocks.shopItemCreate.mock.calls[0][0].data.meta.submissionTxId;

describe.each(sites)('$kind submission fee across an unknown outcome', (site) => {
  it('a retry with the same key after an unanswered charge charges once and submits', async () => {
    ledger.queueFault('lose-response');
    ledger.failLookups();
    // What the creator is told is pinned below; here only that it failed and created nothing.
    await expect(site.submit({ idempotencyKey: KEY })).rejects.toThrow();
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();

    ledger.failLookups(null);
    await site.submit({ idempotencyKey: KEY });

    expect(ledger.charges()).toHaveLength(1);
    expect(ledger.charges()[0].amount).toBe(site.fee);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
    expect(submittedTxId()).toBe(ledger.charges()[0].transactionId);
  });

  it('continues to the item in the same request when the lookup finds the charge', async () => {
    ledger.queueFault('lose-response');

    await site.submit({ idempotencyKey: KEY });

    expect(ledger.charges()).toHaveLength(1);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
    // The ledger's own id, read back for the charge the lost response carried.
    expect(submittedTxId()).toBe(ledger.charges()[0].transactionId);
  });

  it('answers "may have gone through" when the lookup fails, and creates nothing', async () => {
    ledger.queueFault('lose-response');
    ledger.failLookups();

    const error = await site.submit({ idempotencyKey: KEY }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect((error as Error).message).toBe(PAYMENT_OUTCOME_UNKNOWN_MESSAGE);
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();
    expect(buzz.refundTransaction).not.toHaveBeenCalled();
  });

  it('answers "may have gone through" when nothing is found after an unknown outcome', async () => {
    ledger.queueFault('fail-before-commit');

    await expect(site.submit({ idempotencyKey: KEY })).rejects.toThrow(
      PAYMENT_OUTCOME_UNKNOWN_MESSAGE
    );
    expect(ledger.charges()).toHaveLength(0);
    expect(buzz.recoverBuzzTransactionId).not.toHaveBeenCalled();
  });

  it('passes a decline through unchanged when the ledger holds nothing for the key', async () => {
    buzz.createBuzzTransaction.mockRejectedValueOnce(insufficientFunds());

    await expect(site.submit({ idempotencyKey: KEY })).rejects.toThrow(/enough funds/);
    expect(mocks.shopItemCreate).not.toHaveBeenCalled();
  });

  it('continues from an earlier attempt’s charge when this attempt is declined for balance', async () => {
    ledger.queueFault('lose-response');
    ledger.failLookups();
    await site.submit({ idempotencyKey: KEY }).catch(() => undefined);
    ledger.failLookups(null);
    // The earlier charge spent the balance this attempt's pre-check reads.
    buzz.createBuzzTransaction.mockRejectedValueOnce(insufficientFunds());

    await site.submit({ idempotencyKey: KEY });

    expect(ledger.charges()).toHaveLength(1);
    expect(mocks.shopItemCreate).toHaveBeenCalledTimes(1);
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

  it('charges a new submission (a new key) again', async () => {
    await site.submit({ idempotencyKey: KEY });
    await site.submit({ idempotencyKey: OTHER_KEY });

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
