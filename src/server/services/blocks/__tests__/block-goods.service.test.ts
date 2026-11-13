import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BuzzApiError } from '@civitai/buzz';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BuzzService from '~/server/services/buzz.service';
import { buzzAccountTypes, TransactionType } from '~/shared/constants/buzz.constants';
import {
  BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ,
  BLOCK_GOOD_MAX_PRICE_BUZZ,
} from '~/shared/constants/block-goods.constants';

/**
 * App Blocks DIGITAL GOODS — the purchase / entitlement / refund rail.
 *
 * 🔴 WHAT KIND OF COVERAGE THIS IS. Everything here is a BEHAVIOUR SPEC for new
 * code or an INVARIANT GUARD; none of it is regression coverage, because there
 * is no prior behaviour to regress — the module did not exist. Where a test
 * pins something that would otherwise be easy to get wrong later (the FIN-1
 * server-derivation, the recorded-payout reversal, the conservation of the
 * split) it says so on the test.
 *
 * `buzz.service` is spread from the original and only the four money calls are
 * replaced, so a rename in that module fails loudly here instead of silently
 * widening the mock.
 */

type CreateMultiResult = {
  transactionIds: { transactionId: string; accountType: string; amount: number }[];
  totalAmount: number;
  transactionCount: number;
};
type CreateSingleResult = { transactionId: string; remainingBalance: number | null };
type RefundMultiResult = {
  refundedTransactions: {
    originalTransactionId: string;
    refundTransactionId: string;
    accountType: string;
    amount: number;
    originalExternalTransactionId: string;
  }[];
  totalRefunded: number;
  externalTransactionIdPrefix: string;
};

const { mockCreateMulti, mockCreateSingle, mockRefundMulti, mockRefundTransaction } = vi.hoisted(
  () => ({
    // `vi.fn<T>()` rather than named-but-unused parameters: the ARGUMENT TYPES are
    // what make `mock.calls[i][0]` indexable, and naming them only to ignore them
    // trips the unused-vars rule.
    mockCreateMulti: vi.fn<(input: Record<string, unknown>) => Promise<CreateMultiResult>>(
      async () => ({
        transactionIds: [{ transactionId: 'buy-y', accountType: 'yellow', amount: 1000 }],
        totalAmount: 1000,
        transactionCount: 1,
      })
    ),
    mockCreateSingle: vi.fn<(input: Record<string, unknown>) => Promise<CreateSingleResult>>(
      async () => ({ transactionId: 'pay-1', remainingBalance: null as number | null })
    ),
    mockRefundMulti: vi.fn<(input: Record<string, unknown>) => Promise<RefundMultiResult>>(
      async () => ({
        refundedTransactions: [
          {
            originalTransactionId: 'buy-y',
            refundTransactionId: 'ref-1',
            accountType: 'yellow',
            amount: 1000,
            originalExternalTransactionId: 'x',
          },
        ],
        totalRefunded: 1000,
        externalTransactionIdPrefix: 'x',
      })
    ),
    mockRefundTransaction: vi.fn<
      (transactionId: string, description?: string) => Promise<{ ok: boolean }>
    >(async () => ({ ok: true })),
  })
);

vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createMultiAccountBuzzTransaction: mockCreateMulti,
  createBuzzTransaction: mockCreateSingle,
  refundMultiAccountTransaction: mockRefundMulti,
  refundTransaction: mockRefundTransaction,
}));

import {
  blockGoodPayoutTransactionId,
  blockGoodPurchaseKey,
  listBlockGoodEntitlements,
  owesOwnerPayout,
  purchaseBlockGood,
  readRecordedPayouts,
  refundBlockGoodPurchase,
  resolveBlockGoodForPurchase,
  type ResolvedBlockGood,
} from '~/server/services/blocks/block-goods.service';

// 🔴 THE CANONICAL `loggingMock`, NOT A PER-FILE MOCK of the logging client:
// that module is a guarded shared specifier and a per-file mock of it freezes
// this file's shape into every later file in the same worker under
// `isolate: false`. Registered globally in `src/__tests__/setup.ts`.
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const BUYER = 42;
const OWNER = 77;
const APP_BLOCK_ID = 'apb_TESTBLOCK';
const APP_ID = 'appblk-test';
const GOOD_ID = 'extra-slots';
const PRICE = 1000;

/** The base-generation ledger key the fixtures above produce. */
const BUY_KEY = `block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}:buy`;

/**
 * Every ORDERED pair `[shorter, longer]` in which one string is a proper prefix
 * of another, as `"<a>" ⊂ "<b>"` so a failure names the colliding ids rather
 * than printing `false`.
 *
 * 🔴 THIS IS THE INSTRUMENT, so it has its own positive control below. A
 * predicate that can only ever return `[]` would make every prefix-freedom
 * assertion in this file pass while measuring nothing — the reassuring-zero
 * shape.
 */
function prefixPairs(values: string[]): string[] {
  const pairs: string[] = [];
  for (const a of values) {
    for (const b of values) {
      if (a !== b && b.startsWith(a)) pairs.push(`"${a}" ⊂ "${b}"`);
    }
  }
  return pairs;
}

const GOOD = {
  id: GOOD_ID,
  title: 'Extra slots',
  priceBuzz: PRICE,
  kind: 'good' as const,
  payload: { slots: 5 },
};

const RESOLVED: ResolvedBlockGood = {
  appId: APP_ID,
  appOwnerUserId: OWNER,
  manifestVersion: '1.4.0',
  good: GOOD,
};

function purchaseInput(overrides: Partial<Parameters<typeof purchaseBlockGood>[0]> = {}) {
  return {
    buyerUserId: BUYER,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'bki_1',
    goodId: GOOD_ID,
    resolved: RESOLVED,
    payWith: ['blue', 'yellow'] as const,
    ...overrides,
  } as Parameters<typeof purchaseBlockGood>[0];
}

/**
 * The happy-path DB shape: nothing owned, the claim insert succeeds, the settle
 * writes succeed.
 *
 * 🔴 The entitlement stub's payload is deliberately DISTINGUISHABLE from the
 * manifest declaration (`rowOnly: true`). With the two byte-identical, a mutant
 * that built the response entitlement from `resolved.good` instead of the
 * PERSISTED row would be invisible on both `kind` and `payload`.
 */
function stubCleanDb() {
  dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue(null);
  // No earlier generation of this purchase: the base key is derived. Stated
  // rather than left to the mock default, because it is what makes every
  // `BUY_KEY` assertion below mean "base generation".
  dbMock.dbWrite.blockGoodPurchase.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.blockGoodPurchase.updateMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.blockGoodPurchase.create.mockResolvedValue({});
  dbMock.dbWrite.blockGoodPurchase.update.mockResolvedValue({});
  dbMock.dbWrite.blockGoodPurchase.deleteMany.mockResolvedValue({ count: 1 });
  dbMock.dbWrite.blockGoodEntitlement.upsert.mockResolvedValue({
    goodId: GOOD_ID,
    kind: 'good',
    payload: { slots: 5, rowOnly: true },
    grantedAt: new Date('2026-09-27T00:00:00.000Z'),
  });
}

/** A P2002 shaped the way `isUniqueViolation` detects it (by code, not class). */
function uniqueViolation() {
  return Object.assign(new Error('unique constraint'), { code: 'P2002' });
}

/**
 * The REAL error class the Buzz client throws, so `getBuzzApiStatus` can read a
 * status off it. A hand-rolled `{ status }` object would not be recognised, and
 * the test would then pass for the wrong reason — every case would look UNKNOWN.
 */
function buzzApiError(status: number, statusText: string) {
  return new BuzzApiError(status, statusText);
}

beforeEach(() => {
  vi.clearAllMocks();
  // 🔴 `clearAllMocks` clears CALLS, not IMPLEMENTATIONS, and nothing in
  // `vitest.config.mts` sets `mockReset`. A `mockImplementation` or
  // `mockRejectedValue` set inside one test therefore survives into every test
  // after it, and the file was relying on ordering for that not to matter.
  // `mockReset` on a `vi.fn(impl)` restores the implementation the hoisted
  // factory gave it, so each test starts from the documented happy path.
  for (const mock of [mockCreateMulti, mockCreateSingle, mockRefundMulti, mockRefundTransaction])
    mock.mockReset();
  stubCleanDb();
});

describe('resolveBlockGoodForPurchase — FIN-1 server derivation', () => {
  it('derives app, OWNER, manifest version and PRICE from the AppBlock row', () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
      appId: APP_ID,
      status: 'approved',
      version: '1.4.0',
      manifest: { goods: [{ id: GOOD_ID, title: 'Extra slots', priceBuzz: PRICE }] },
      app: { userId: OWNER },
    });
    return expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toEqual({
      appId: APP_ID,
      appOwnerUserId: OWNER,
      manifestVersion: '1.4.0',
      good: expect.objectContaining({ id: GOOD_ID, priceBuzz: PRICE }),
    });
  });

  it('refuses an app that is not APPROVED', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
      appId: APP_ID,
      status: 'pending',
      version: '1.4.0',
      manifest: { goods: [{ id: GOOD_ID, title: 'Extra slots', priceBuzz: PRICE }] },
      app: { userId: OWNER },
    });
    await expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toBeNull();
  });

  it('refuses an app with no resolvable owner', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
      appId: APP_ID,
      status: 'approved',
      version: '1.4.0',
      manifest: { goods: [{ id: GOOD_ID, title: 'Extra slots', priceBuzz: PRICE }] },
      app: null,
    });
    await expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toBeNull();
  });

  it('refuses a good the approved manifest does not declare', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue({
      appId: APP_ID,
      status: 'approved',
      version: '1.4.0',
      manifest: { goods: [{ id: 'something-else', title: 'Other', priceBuzz: 300 }] },
      app: { userId: OWNER },
    });
    await expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toBeNull();
  });

  it('refuses a missing AppBlock row entirely', async () => {
    dbMock.dbRead.appBlock.findUnique.mockResolvedValue(null);
    await expect(
      resolveBlockGoodForPurchase({ appBlockId: APP_BLOCK_ID, goodId: GOOD_ID })
    ).resolves.toBeNull();
  });
});

describe('prefixPairs — the instrument the key guards read', () => {
  it('REPORTS a prefix pair, and reports nothing when there is none', () => {
    // 🔴 POSITIVE CONTROL. Without this, `expect(prefixPairs(keys)).toEqual([])`
    // is indistinguishable from a predicate wired to nothing — and the exact
    // shape of the original defect (`…:5` inside `…:51`) is what it is fed.
    expect(prefixPairs(['block-good:a:g:5', 'block-good:a:g:51'])).toEqual([
      '"block-good:a:g:5" ⊂ "block-good:a:g:51"',
    ]);
    // …and the second shape: a base key inside its own `after:` variant.
    expect(prefixPairs(['k', 'k:after:x'])).toHaveLength(1);
    // Distinct-but-unrelated ids are NOT reported, so a green run means the
    // property held rather than the predicate being blind in the other
    // direction. Equal-length ids cannot prefix each other, which is why the
    // old distinctness guard could not see the bug.
    expect(prefixPairs(['block-good:a:g:42', 'block-good:a:g:43'])).toEqual([]);
  });
});

describe('blockGoodPurchaseKey — the ledger anchor', () => {
  it('is deterministic in (app, good, buyer) and carries nothing else', () => {
    // 🔴 THE PROPERTY THE WHOLE LEDGER-BACKED DEDUPE RESTS ON. If this string
    // ever gains a random or per-attempt component, a retry after the Redis
    // sentinel expires charges a second time.
    const a = blockGoodPurchaseKey({
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      buyerUserId: BUYER,
    });
    const b = blockGoodPurchaseKey({
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      buyerUserId: BUYER,
    });
    expect(a).toBe(b);
    expect(a).toBe(BUY_KEY);
  });

  it('gives a RE-PURCHASE its own key, so a refunded good can be bought again', () => {
    // 🔴 THE DEFECT THIS EXISTS FOR. Without the supersedes segment the second
    // purchase of a refunded good derives the SAME key as the first, collides
    // on the Buzz ledger and on the UNIQUE `buzz_transaction_id`, and the
    // viewer is told the purchase is already complete — forever.
    const first = blockGoodPurchaseKey({
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      buyerUserId: BUYER,
    });
    const second = blockGoodPurchaseKey({
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      buyerUserId: BUYER,
      supersedesPurchaseId: 'bgp_FIRST',
    });
    expect(second).not.toBe(first);
    // …and it is still deterministic WITHIN that generation, which is what
    // keeps the ledger dedupe working for a retry of the re-purchase.
    expect(
      blockGoodPurchaseKey({
        appBlockId: APP_BLOCK_ID,
        goodId: GOOD_ID,
        buyerUserId: BUYER,
        supersedesPurchaseId: 'bgp_FIRST',
      })
    ).toBe(second);
    // A THIRD generation differs again.
    expect(
      blockGoodPurchaseKey({
        appBlockId: APP_BLOCK_ID,
        goodId: GOOD_ID,
        buyerUserId: BUYER,
        supersedesPurchaseId: 'bgp_SECOND',
      })
    ).not.toBe(second);
  });

  it('🔴 is PREFIX-FREE across buyers, goods, apps and both generation shapes', () => {
    // 🔴 THE DEFECT THIS REPLACES A DISTINCTNESS TEST FOR. The old assertion was
    // `new Set([...]).size === 4` over buyers 42 and 43 — same length, so they
    // cannot prefix each other, and the guard could not fail on the bug that
    // existed. Distinct ids collide under a PREFIX match all day, and a prefix
    // match is exactly what `rollbackCharge` and `refundBlockGoodPurchase` do:
    // with the buyer id last and unterminated, buyer 5's key was inside buyer
    // 51's and 500's, so rolling back one attempt REVERSED their settled
    // purchases — entitlements kept, Buzz returned, owner's 70% kept, nothing
    // raised.
    //
    // The buyer ids below are chosen so two of them ARE string prefixes of a
    // third (5 ⊂ 51 ⊂ 500 as digit strings); the goods and app ids likewise.
    // A scheme that only separated same-length ids passes the old test and
    // fails this one.
    const keys: string[] = [];
    for (const appBlockId of ['apb_A', 'apb_AB']) {
      for (const goodId of ['sword', 'sword-2']) {
        for (const buyerUserId of [5, 51, 500]) {
          for (const supersedesPurchaseId of [null, 'bgp_ONE', 'bgp_ONETWO']) {
            keys.push(
              blockGoodPurchaseKey({ appBlockId, goodId, buyerUserId, supersedesPurchaseId })
            );
          }
        }
      }
    }

    // Distinctness first — prefix-freedom implies it, so a failure here would
    // mean something much worse than the bug under test.
    expect(new Set(keys).size).toBe(keys.length);
    expect(prefixPairs(keys)).toEqual([]);
  });

  it('🔴 keeps the OWNER payout ids OUTSIDE the buyer key’s prefix, for EVERY colour', () => {
    // The mirror of the case above, one function over. The payout leg used to
    // be built as `${purchaseKey}:sell:…`, which put the buyer's whole prefix
    // inside every credit: a refund's prefix reversal of the BUYER would then
    // also reverse the owner's legs, inflating `buyerRefundedBuzz` and failing
    // every by-id clawback afterwards as already-reversed.
    //
    // 🔴 THE COLOURS ARE THE WHOLE `BuzzAccountType` ENUM, NOT THE TWO THIS RAIL
    // PAYS IN. `blockGoodPurchaseKey`'s clause (b) claims every id ends in a
    // literal token so no id can run out against another mid-segment — and a
    // guard over blue/yellow alone is NARROWER than the claim it backs, because
    // `creatorProgramBank` IS a string prefix of `creatorProgramBankGreen`. The
    // enum is iterated rather than listed so a colour added later is covered
    // without anyone remembering to come back here.
    expect(buzzAccountTypes.length).toBeGreaterThan(2);
    const keyArgs = [
      { appBlockId: 'apb_A', goodId: 'sword', buyerUserId: 5 },
      { appBlockId: 'apb_A', goodId: 'sword', buyerUserId: 51, supersedesPurchaseId: 'bgp_ONE' },
    ];
    const ids = keyArgs.flatMap((args) => [
      blockGoodPurchaseKey(args),
      // A second recipient is not paid today, but the id shape already admits
      // one and the separation has to hold when it is. Recipients 7 and 77 are
      // prefix-related as digit strings, like the buyer ids above.
      ...[OWNER, 7].flatMap((recipientUserId) =>
        buzzAccountTypes.map((color) =>
          blockGoodPayoutTransactionId({ ...args, recipientUserId, color })
        )
      ),
    ]);
    expect(prefixPairs(ids)).toEqual([]);
  });
});

describe('purchaseBlockGood — the money path', () => {
  it('charges the buyer, grants the entitlement and pays the owner 70%', async () => {
    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);

    // The DEBIT: the buyer, the server price, under the deterministic key.
    expect(mockCreateMulti).toHaveBeenCalledTimes(1);
    expect(mockCreateMulti).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountId: BUYER,
        toAccountId: 0,
        amount: PRICE,
        type: TransactionType.Purchase,
        externalTransactionIdPrefix: BUY_KEY,
      })
    );

    // The CREDIT: the owner, 70% of 1000 = 700, as a Sell from the bank.
    expect(mockCreateSingle).toHaveBeenCalledTimes(1);
    expect(mockCreateSingle).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountId: 0,
        toAccountId: OWNER,
        amount: 700,
        type: TransactionType.Sell,
      })
    );

    // The LEDGER ROW carries the split, and the two shares sum to the price —
    // the same invariant the database CHECK enforces.
    const row = dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data;
    expect(row.priceBuzz).toBe(PRICE);
    expect(row.appOwnerShareBuzz).toBe(700);
    expect(row.platformShareBuzz).toBe(300);
    expect(row.appOwnerShareBuzz + row.platformShareBuzz).toBe(row.priceBuzz);
    // 🔴 `payouts` is written EXPLICITLY as an empty ARRAY, not left to the
    // column default: the migration's `jsonb_typeof(payouts) = 'array'` CHECK
    // rejects a JSON string, and Prisma carries a `Json` field's default as a
    // string. Leaving it out makes every insert depend on how the client
    // applies that default.
    expect(row.payouts).toEqual([]);
    // 🔴 The UNIQUE column the whole claim-then-charge ordering rests on. Without
    // this, a mutant writing a fresh ULID here would leave the index no longer
    // holding the deterministic key — the claim would stop serialising attempts
    // and the pre-charge replay could never hit — with every other assertion
    // green, because the CHARGE's prefix is a different write.
    expect(row.buzzTransactionId).toBe(BUY_KEY);
    // The row is CLAIMED, not born paid: `pending` until the charge settles.
    expect(row.status).toBe('pending');
    expect(row.bluePaidBuzz).toBe(0);

    // …and the SETTLE flips it, carrying the colour split the charge reported.
    expect(dbMock.dbWrite.blockGoodPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id },
        data: { status: 'paid', bluePaidBuzz: 0 },
      })
    );

    // The returned entitlement comes from the PERSISTED row, not from the
    // manifest declaration — the stub's payload carries a marker the manifest
    // cannot produce, so the two sources are separable.
    expect((result as { entitlement: { payload: unknown } }).entitlement.payload).toEqual({
      slots: 5,
      rowOnly: true,
    });
  });

  it('CLAIMS the row before charging — the ordering the safety argument rests on', async () => {
    // 🔴 Invariant guard on the ORDER itself. With charge-then-claim, two
    // concurrent attempts both charge under the deterministic prefix and the
    // loser's prefix-wide rollback reverses the WINNER's charge. The insert
    // happening first is what makes the database serialise them instead.
    const order: string[] = [];
    dbMock.dbWrite.blockGoodPurchase.create.mockImplementation(async () => {
      order.push('claim');
      return {};
    });
    mockCreateMulti.mockImplementationOnce(async () => {
      order.push('charge');
      return {
        transactionIds: [{ transactionId: 'buy-y', accountType: 'yellow', amount: PRICE }],
        totalAmount: PRICE,
        transactionCount: 1,
      };
    });
    await purchaseBlockGood(purchaseInput());
    expect(order).toEqual(['claim', 'charge']);
  });

  it('records the OWNER resolved at write time, not a client value', async () => {
    await purchaseBlockGood(purchaseInput());
    const row = dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data;
    expect(row.appOwnerUserId).toBe(OWNER);
    expect(row.userId).toBe(BUYER);
    expect(row.appId).toBe(APP_ID);
    expect(row.manifestVersion).toBe('1.4.0');
  });

  it('snapshots the MANIFEST payload and kind onto the entitlement', async () => {
    await purchaseBlockGood(purchaseInput());
    const upsert = dbMock.dbWrite.blockGoodEntitlement.upsert.mock.calls[0][0];
    expect(upsert.create.payload).toEqual({ slots: 5 });
    expect(upsert.create.kind).toBe('good');
    expect(upsert.where).toEqual({
      userId_appBlockId_goodId: { userId: BUYER, appBlockId: APP_BLOCK_ID, goodId: GOOD_ID },
    });
  });

  it('carries an app_unlock good through as an ORDINARY entitlement (nothing branches on it)', async () => {
    // D4 — the paid-app unlock is expressible today and inert today. This is an
    // INVARIANT GUARD on the data model, not coverage of any behaviour.
    dbMock.dbWrite.blockGoodEntitlement.upsert.mockResolvedValue({
      goodId: 'unlock',
      kind: 'app_unlock',
      payload: {},
      grantedAt: new Date('2026-09-27T00:00:00.000Z'),
    });
    const result = await purchaseBlockGood(
      purchaseInput({
        goodId: 'unlock',
        resolved: {
          ...RESOLVED,
          good: { ...GOOD, id: 'unlock', kind: 'app_unlock', payload: {} },
        },
      })
    );
    expect(result.ok).toBe(true);
    expect(dbMock.dbWrite.blockGoodEntitlement.upsert.mock.calls[0][0].create.kind).toBe(
      'app_unlock'
    );
    // The charge and payout are identical to any other good.
    expect(mockCreateSingle).toHaveBeenCalledWith(expect.objectContaining({ amount: 700 }));
  });

  it('splits the OWNER payout across colours in proportion to what the buyer paid in blue', async () => {
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-b', accountType: 'blue', amount: 400 },
        { transactionId: 'buy-y', accountType: 'yellow', amount: 600 },
      ],
      totalAmount: PRICE,
      transactionCount: 2,
    } as never);

    await purchaseBlockGood(purchaseInput());

    // owner share 700, blue leg floor(700*400/1000) = 280, yellow leg 420.
    expect(mockCreateSingle).toHaveBeenCalledTimes(2);
    const legs = mockCreateSingle.mock.calls.map((c) => {
      const arg = c[0] as { amount: number; toAccountType: string; externalTransactionId: string };
      return { amount: arg.amount, color: arg.toAccountType };
    });
    expect(legs).toEqual([
      { amount: 280, color: 'blue' },
      { amount: 420, color: 'yellow' },
    ]);
    expect(legs[0].amount + legs[1].amount).toBe(700);

    // The external ids differ per colour — a collision here would silently drop
    // one of the two legs as a duplicate.
    const ids = mockCreateSingle.mock.calls.map(
      (c) => (c[0] as { externalTransactionId: string }).externalTransactionId
    );
    expect(new Set(ids).size).toBe(2);

    // 🔴 `bluePaidBuzz` is the ONE figure that needs the charge's answer, so it is
    // written by the SETTLE, not by the claim — the claim row starts it at 0.
    expect(dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data.bluePaidBuzz).toBe(0);
    expect(dbMock.dbWrite.blockGoodPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'paid', bluePaidBuzz: 400 } })
    );
  });

  it('RECORDS what was actually paid, per colour, with the ledger transaction id', async () => {
    mockCreateSingle
      .mockResolvedValueOnce({ transactionId: 'pay-blue', remainingBalance: null } as never)
      .mockResolvedValueOnce({ transactionId: 'pay-yellow', remainingBalance: null } as never);
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-b', accountType: 'blue', amount: 400 },
        { transactionId: 'buy-y', accountType: 'yellow', amount: 600 },
      ],
      totalAmount: PRICE,
      transactionCount: 2,
    } as never);

    await purchaseBlockGood(purchaseInput());

    expect(dbMock.dbWrite.blockGoodPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          payouts: [
            { userId: OWNER, amount: 280, color: 'blue', transactionId: 'pay-blue' },
            { userId: OWNER, amount: 420, color: 'yellow', transactionId: 'pay-yellow' },
          ],
        },
      })
    );
  });

  it('REFUSES a buyer who already owns the good, before any money moves', async () => {
    dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue({
      goodId: GOOD_ID,
      kind: 'good',
      payload: {},
      grantedAt: new Date(),
      revokedAt: null,
    });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'already_owned' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.create).not.toHaveBeenCalled();
  });

  it('ALLOWS re-buying after a REVOKED entitlement, under a DIFFERENT ledger key', async () => {
    dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue({
      revokedAt: new Date('2026-09-20T00:00:00.000Z'),
    });
    // The generation now comes from the PURCHASE row, not the entitlement —
    // see `newestSupersededPurchaseId`.
    dbMock.dbWrite.blockGoodPurchase.findFirst.mockResolvedValue({ id: 'bgp_FIRST' });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);

    // 🔴 The whole point: the re-purchase must NOT reuse the first purchase's
    // external id, or the Buzz ledger refuses the charge and the UNIQUE
    // `buzz_transaction_id` refuses the row. The looked-up id BEFORE the charge
    // must be the new key too, or the pre-charge replay check finds the
    // original row and 409s.
    const chargeKey = (mockCreateMulti.mock.calls[0][0] as { externalTransactionIdPrefix: string })
      .externalTransactionIdPrefix;
    expect(chargeKey).not.toBe(BUY_KEY);
    expect(chargeKey).toBe(`block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}:after:bgp_FIRST:buy`);
    expect(dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data.buzzTransactionId).toBe(
      chargeKey
    );
    // 🔴 …and it is only searching within THIS (buyer, app, good). A lookup that
    // dropped one of the three would supersede an unrelated purchase and derive
    // a key that has nothing to do with this good.
    expect(dbMock.dbWrite.blockGoodPurchase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: BUYER,
          appBlockId: APP_BLOCK_ID,
          goodId: GOOD_ID,
          status: 'refunded',
        },
      })
    );
  });

  it('uses the BASE key on a first purchase — the supersedes segment is not always on', () => {
    // Negative control for the case above: if the segment were appended
    // unconditionally, the assertion there would pass while every first
    // purchase carried a meaningless `:after:undefined` tail.
    return purchaseBlockGood(purchaseInput()).then(() => {
      expect(
        (mockCreateMulti.mock.calls[0][0] as { externalTransactionIdPrefix: string })
          .externalTransactionIdPrefix
      ).toBe(BUY_KEY);
    });
  });

  it('does NOT re-key when the entitlement exists and is NOT revoked', async () => {
    // That case is refused as already-owned before any key is derived; this
    // pins that the re-key is driven by `revokedAt`, not by the row existing.
    dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue({
      goodId: GOOD_ID,
      kind: 'good',
      payload: {},
      grantedAt: new Date(),
      revokedAt: null,
      purchaseId: 'bgp_FIRST',
    });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, reason: 'already_owned' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('REFUSES the app owner buying their own good', async () => {
    const result = await purchaseBlockGood(purchaseInput({ buyerUserId: OWNER }));
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'self_purchase' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('REFUSES when expectedPriceBuzz disagrees with the server price', async () => {
    const result = await purchaseBlockGood(purchaseInput({ expectedPriceBuzz: 999 }));
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'price_changed' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('charges the SERVER price, never the client expectation, when they agree', async () => {
    // 🔴 FIN-1. `expectedPriceBuzz` may only cause a refusal; it can never be
    // the number charged. A mutant that passes it to the charge survives a test
    // that only ever sends a matching value, so the assertion names the SOURCE.
    await purchaseBlockGood(purchaseInput({ expectedPriceBuzz: PRICE }));
    expect(mockCreateMulti).toHaveBeenCalledWith(
      expect.objectContaining({ amount: RESOLVED.good.priceBuzz })
    );
  });

  it('REFUSES a good priced over the hard cap even if the manifest was approved with it', async () => {
    const result = await purchaseBlockGood(
      purchaseInput({
        resolved: { ...RESOLVED, good: { ...GOOD, priceBuzz: 10_000_000 } },
      })
    );
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'price_over_cap' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('REFUSES an app_unlock over the UNLOCK cap at a price an ordinary good may charge', async () => {
    // 🔴 THE ONLY TEST THAT CAN SEE THE PER-KIND CEILING ON THE MONEY PATH. The case
    // above uses `kind: 'good'` at 10,000,000, which refuses identically whether this
    // guard reads the general cap or the per-kind one — so until this case existed,
    // reverting `maxPriceBuzzForKind(good.kind)` to `BLOCK_GOOD_MAX_PRICE_BUZZ` left
    // the entire suite green while an app unlock was bounded at 10x its real cap.
    //
    // The price is the discriminator: 5,001 is LEGAL for an ordinary good and over the
    // ceiling for an unlock, so only a kind-aware guard can refuse it. Nothing is
    // charged — asserted, because a 400 that still debited would be far worse than a
    // missing bound.
    const price = BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ + 1;
    expect(price).toBeLessThanOrEqual(BLOCK_GOOD_MAX_PRICE_BUZZ);
    const result = await purchaseBlockGood(
      purchaseInput({
        resolved: {
          ...RESOLVED,
          good: { ...GOOD, kind: 'app_unlock' as const, priceBuzz: price },
        },
      })
    );
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'price_over_cap' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('ALLOWS an app_unlock exactly AT the unlock cap — the boundary, and the control', async () => {
    // Without this, a `>` → `>=` mutant on the same line survives; and it is also the
    // control proving the refusal above is about the PRICE rather than about the kind
    // being rejected outright.
    const result = await purchaseBlockGood(
      purchaseInput({
        resolved: {
          ...RESOLVED,
          good: { ...GOOD, kind: 'app_unlock' as const, priceBuzz: BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ },
        },
      })
    );
    // 🔴 THE CLAIM IS "THE CEILING DID NOT FIRE", AND IT IS ASSERTED ON THE CHARGE, not
    // on `ok`. `not.toMatchObject({reason})` alone does not discriminate — it passes for
    // any other refusal and for a result with no `reason` at all. But `ok: true` would
    // OVER-specify: this shared fixture only wires a successful Buzz response for the
    // default price, so at a non-default amount the attempt gets past the ceiling and
    // then returns `charge_failed` from the mock. That is a harness artefact, not a
    // bound — do not chase it. What proves the ceiling allowed exactly-at-the-cap is
    // that the charge was ATTEMPTED, at that amount, which no `price_over_cap` refusal
    // could ever reach (it returns `charge: 'none'` before any debit).
    expect(result).not.toMatchObject({ reason: 'price_over_cap' });
    expect(mockCreateMulti).toHaveBeenCalledWith(
      expect.objectContaining({ amount: BLOCK_APP_UNLOCK_MAX_PRICE_BUZZ })
    );
  });

  it('REFUSES as a duplicate when another attempt already SETTLED this purchase, without charging', async () => {
    dbMock.dbWrite.blockGoodPurchase.create.mockRejectedValueOnce(uniqueViolation());
    dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue({ status: 'paid' });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'duplicate' });
    // 🔴 NOTHING is charged and — critically — NOTHING is rolled back. The money
    // under this key belongs to the attempt that won the claim; a prefix-wide
    // reversal here is exactly the defect claim-then-charge exists to prevent.
    expect(mockCreateMulti).not.toHaveBeenCalled();
    expect(mockRefundMulti).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
  });

  it('reports PENDING_RECONCILIATION when the winning claim has not settled', async () => {
    // Telling the viewer "already completed" would be a lie, and telling them to
    // retry sends them into a permanent wall — the key is taken by a charge whose
    // outcome nobody knows yet.
    dbMock.dbWrite.blockGoodPurchase.create.mockRejectedValueOnce(uniqueViolation());
    dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue({ status: 'pending' });
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'pending_reconciliation' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
    expect(mockRefundMulti).not.toHaveBeenCalled();
  });

  it('500s on a claim write failure that is NOT a unique violation', async () => {
    dbMock.dbWrite.blockGoodPurchase.create.mockRejectedValueOnce(new Error('db down'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 500, reason: 'charge_failed' });
    expect(mockCreateMulti).not.toHaveBeenCalled();
  });

  it('returns a clean 400 and RELEASES the claim when the ledger REFUSES the debit (400)', async () => {
    mockCreateMulti.mockRejectedValueOnce(buzzApiError(400, 'Insufficient funds'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'insufficient_funds' });
    // 🔴 The driver's own text must NOT reach the response body.
    expect((result as { error: string }).error).not.toContain('Insufficient funds');
    // The claim is released — guarded on `pending`, so it can never remove a
    // settled purchase — because we KNOW no money moved and a genuine retry (once
    // the viewer tops up) must be able to buy this good.
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).toHaveBeenCalledWith({
      where: { id: expect.any(String), status: 'pending' },
    });
    expect(mockRefundMulti).not.toHaveBeenCalled();
    expect(mockCreateSingle).not.toHaveBeenCalled();
  });

  it('🔴 does NOT call a ledger DEDUPE conflict "insufficient funds"', async () => {
    // 🔴 THE DEFECT. 400, 404 and 409 all mean "no money moved on this attempt",
    // and that ONE fact was being turned into ONE message. A 409 is the ledger
    // saying the external id is already occupied — which a REVERSED transaction
    // still is — so the viewer was told they were out of Buzz about a key no
    // amount of topping up can get past.
    mockCreateMulti.mockRejectedValueOnce(buzzApiError(409, 'Conflict'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 409, reason: 'ledger_conflict' });
    expect((result as { error: string }).error).not.toMatch(/enough Buzz/i);
    // Nothing entered the ledger on THIS attempt, so the claim is released and
    // the caller gets its daily-cap reservation back.
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ charge: 'none', retryable: false });
  });

  it('does not call an UNRESOLVABLE ledger request (404) "insufficient funds" either', async () => {
    mockCreateMulti.mockRejectedValueOnce(buzzApiError(404, 'Not Found'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'charge_failed' });
    expect((result as { error: string }).error).not.toMatch(/enough Buzz/i);
    expect(result).toMatchObject({ charge: 'none' });
  });

  it('🔴 does NOT cache a refusal a top-up could reverse — only the 409 is unretryable', async () => {
    // 🔴 THE DEFECT. One `return` covered 400, 404 and 409 with
    // `retryable: false`, contradicting `retryable`'s own definition ("an
    // identical retry could reach a DIFFERENT verdict, so this outcome must not
    // be cached") for two of the three. The endpoint sets
    // `transient: retryable === true`, so a 400 was cached for the full
    // idempotency TTL and REPLAYED at the viewer — the key blocking the retry
    // it exists to enable, right after the top-up that would have worked. Only
    // 409 genuinely cannot change: the ledger holds that id forever.
    //
    // All three arms in one test on purpose: the 409 is the control that proves
    // the value is DERIVED and not hardcoded true.
    mockCreateMulti.mockRejectedValueOnce(buzzApiError(400, 'Insufficient funds'));
    expect(await purchaseBlockGood(purchaseInput())).toMatchObject({
      reason: 'insufficient_funds',
      charge: 'none',
      retryable: true,
    });

    mockCreateMulti.mockRejectedValueOnce(buzzApiError(404, 'Not Found'));
    expect(await purchaseBlockGood(purchaseInput())).toMatchObject({
      reason: 'charge_failed',
      charge: 'none',
      retryable: true,
    });

    mockCreateMulti.mockRejectedValueOnce(buzzApiError(409, 'Conflict'));
    expect(await purchaseBlockGood(purchaseInput())).toMatchObject({
      reason: 'ledger_conflict',
      charge: 'none',
      retryable: false,
    });
  });

  it('🔴 refuses a charge whose legs the ledger marked DUPLICATE, granting nothing', async () => {
    // 🔴 THE DEFECT. `ledger_conflict` was reachable only through a 409 THROW,
    // on the unverified assumption that an occupied prefix is how the
    // multi-account endpoint reports one. Its response carries a per-leg
    // `duplicate` flag, so it may instead answer 200 with legs that reference
    // an EARLIER request's transactions — and this fixture is deliberately
    // shaped so every other check passes: `totalAmount` equals the price and
    // `transactionCount` is 1, so the partial-debit refusal cannot be what
    // catches it. Without this branch the entitlement is granted and the owner
    // is paid 70% of Buzz that did not move on this attempt.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-y', accountType: 'yellow', amount: PRICE, duplicate: true },
      ],
      totalAmount: PRICE,
      transactionCount: 1,
    } as never);

    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      reason: 'ledger_conflict',
      // UNKNOWN, not `none`, for the whole branch: the rule has to cover a
      // MIXED response, where some legs are new money, so the caller keeps the
      // viewer's cap reservation rather than asserting a clean no-op.
      charge: 'unknown',
      retryable: false,
    });
    expect(dbMock.dbWrite.blockGoodEntitlement.upsert).not.toHaveBeenCalled();
    expect(mockCreateSingle).not.toHaveBeenCalled();
    // Nothing is reversed — a prefix-wide reversal would take back the earlier
    // request's legs too — and the `pending` row survives as the only record.
    expect(mockRefundMulti).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
  });

  it('🔴 refuses a MIXED response too — one duplicate leg is enough', async () => {
    // ANY duplicate leg refuses, not only an all-duplicate response: a mixed
    // one is a charge whose legs are partly references to an earlier request's
    // transactions, so neither "nothing moved" nor "the full price moved" is
    // true of it. The fixture's total still equals the price, so — as above —
    // no other check can be what catches this.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-b', accountType: 'blue', amount: 400, duplicate: true },
        { transactionId: 'buy-y', accountType: 'yellow', amount: 600, duplicate: false },
      ],
      totalAmount: PRICE,
      transactionCount: 2,
    } as never);
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, reason: 'ledger_conflict', charge: 'unknown' });
    expect(dbMock.dbWrite.blockGoodEntitlement.upsert).not.toHaveBeenCalled();
    expect(mockCreateSingle).not.toHaveBeenCalled();
  });

  it('completes normally when the same response marks its legs NOT duplicate', async () => {
    // Negative control for the branch above: the refusal must be driven by the
    // flag, not by the fixture shape it happens to arrive in.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-y', accountType: 'yellow', amount: PRICE, duplicate: false },
      ],
      totalAmount: PRICE,
      transactionCount: 1,
    } as never);
    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);
    expect(mockCreateSingle).toHaveBeenCalledTimes(1);
  });

  it('🔴 does NOT reverse a SHORT duplicate response — the ORDER of the two checks (INVARIANT GUARD)', async () => {
    // 🔴 THIS IS AN INVARIANT GUARD, NOT REGRESSION COVERAGE: the duplicate
    // check already precedes the partial-debit check, so this is green on the
    // code it was written against. What it pins is the ORDER, and nothing else
    // in this file can see it — both duplicate fixtures above set
    // `totalAmount` to the price deliberately, so they take the same path
    // whichever order the two checks are in. A mutant that swapped them
    // survived the whole suite.
    //
    // The fixture is the case only the order decides: duplicate AND short.
    // With the checks swapped the partial-debit branch wins, and its reversal
    // is PREFIX-WIDE — `rollbackCharge` would take back the EARLIER request's
    // settled legs, `voidReversedClaim` would tombstone this row, and the
    // viewer would be told `charge: 'reversed'` about money that did not come
    // back to them. 400 is distinct from the price (1000) and from both shares
    // (700/300), so no assertion here can pass by coincidence.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-b', accountType: 'blue', amount: 400, duplicate: true },
      ],
      totalAmount: 400,
      transactionCount: 1,
    } as never);

    const result = await purchaseBlockGood(purchaseInput());
    // 🔴 THE LOAD-BEARING ASSERTION. Everything else here is corroboration:
    // this one is what the swap breaks, and it is about another request's money.
    expect(mockRefundMulti).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      status: 409,
      reason: 'ledger_conflict',
      charge: 'unknown',
      retryable: false,
    });
    // No tombstone either — `voidReversedClaim` asserts a reversal that the
    // assertion above says did not happen.
    expect(dbMock.dbWrite.blockGoodPurchase.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodEntitlement.upsert).not.toHaveBeenCalled();
    expect(mockCreateSingle).not.toHaveBeenCalled();
  });

  it('🔴 COUNTS the legs that reported no `duplicate` flag at all, on the duplicate log', async () => {
    // 🔴 THE DUPLICATE GUARD'S LIVENESS IS OTHERWISE UNOBSERVABLE. Both tests
    // in the branch are `=== true`, so "not reported" and `false` are the same
    // path: if the service omits the field the branch is permanently dead and
    // the code still reads as handling the hazard. Nothing counted that.
    //
    // The three counts here are pairwise distinct (1 / 2 / 3), which is what
    // makes a mutant REUSING `duplicateLegs` or `totalLegs` for the new field
    // visible. That is all it does: distinctness within one fixture cannot see
    // a mutant that hardcodes the *expected* value, because the assertion names
    // that literal. The sibling test below is what kills that one — it expects
    // 1 where this expects 2, so no single constant satisfies both.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-b', accountType: 'blue', amount: 400, duplicate: true },
        { transactionId: 'buy-y', accountType: 'yellow', amount: 300 },
        { transactionId: 'buy-y2', accountType: 'yellow', amount: 300 },
      ],
      totalAmount: PRICE,
      transactionCount: 3,
    } as never);

    await purchaseBlockGood(purchaseInput());
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'purchase charge reported DUPLICATE legs — the ledger key was already occupied',
        duplicateLegs: 1,
        legsWithoutDuplicateFlag: 2,
        totalLegs: 3,
      }),
      'civitai-prod'
    );
  });

  it('🔴 carries that count on the NON-duplicate population too — the log a dead branch still reaches', async () => {
    // The copy that can actually answer the open question. Reaching the
    // partial-debit log means NO leg reported `true`, so a non-zero here is a
    // response the service sent without the field — which is the shape that
    // would make the duplicate branch above dead. (A permanent zero is not the
    // converse proof: a clean charge writes no log at all. Stated on the
    // service too.)
    //
    // The expected count here is 1, deliberately NOT the 2 the sibling test
    // above expects: a mutant replacing the computation with a literal has to
    // satisfy both, and no constant does. The `duplicate: false` leg is what
    // buys the difference, and it pins the other half of the predicate at the
    // same time — the field is counted when it is not a boolean, so an
    // explicit `false` is a REPORTED flag and must not be counted.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-y', accountType: 'yellow', amount: 400, duplicate: false },
        { transactionId: 'buy-y2', accountType: 'yellow', amount: 200 },
      ],
      totalAmount: 600,
      transactionCount: 2,
    } as never);

    await purchaseBlockGood(purchaseInput());
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'purchase charge did not fully land',
        chargedTotal: 600,
        legsWithoutDuplicateFlag: 1,
      }),
      'civitai-prod'
    );
  });

  it('🔴 lets a RETRY SUCCEED after an attempt whose charge was reversed', async () => {
    // 🔴 THE BRICK. The first attempt charges, fails to grant, reverses, and —
    // before this fix — DELETED its claim row. A reversed external id stays
    // occupied in the ledger, so the retry re-derived the identical key, the
    // ledger 409'd, and 409 was reported as `insufficient_funds`: a viewer with
    // plenty of Buzz permanently unable to buy that good, told they were broke.
    //
    // The two halves are tested together on purpose — the tombstone is worth
    // nothing unless the next attempt reads it, and the lookup is worth nothing
    // unless something was left to find. Neither alone closes the defect.
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(new Error('db down'));
    const first = await purchaseBlockGood(purchaseInput());
    expect(first).toMatchObject({ ok: false, reason: 'charge_failed' });

    // Asserted before reading the call, so a failure says "the tombstone was
    // never written" rather than dying on `undefined`. The charge/retryable
    // discriminators are NOT checked here — they belong to the endpoint's
    // cap-and-cache decision and have their own tests; mixing them in makes
    // this test fail for the other finding's reason.
    const firstPurchaseId = dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data.id;
    expect(dbMock.dbWrite.blockGoodPurchase.updateMany).toHaveBeenCalledTimes(1);
    const tombstone = dbMock.dbWrite.blockGoodPurchase.updateMany.mock.calls[0][0];
    expect(tombstone.where).toEqual({ id: firstPurchaseId, status: 'pending' });
    // Both refund fields or neither — the table's CHECK rejects a half-set pair,
    // so a tombstone carrying only the status would fail to write at all.
    expect(tombstone.data.status).toBe('refunded');
    expect(tombstone.data.refundedAt).toBeInstanceOf(Date);
    expect(typeof tombstone.data.refundReason).toBe('string');

    // The retry: that row is now the newest superseded generation.
    dbMock.dbWrite.blockGoodPurchase.findFirst.mockResolvedValue({ id: firstPurchaseId });
    const second = await purchaseBlockGood(purchaseInput());
    expect(second.ok).toBe(true);

    const keys = mockCreateMulti.mock.calls.map(
      (c) => (c[0] as { externalTransactionIdPrefix: string }).externalTransactionIdPrefix
    );
    expect(keys[0]).toBe(BUY_KEY);
    expect(keys[1]).toBe(
      `block-good:${APP_BLOCK_ID}:${GOOD_ID}:${BUYER}:after:${firstPurchaseId}:buy`
    );
    // Named as its own assertion: the ONE thing the ledger cares about is that
    // the second charge is not under the first's key.
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('🔴 does NOT call an UNKNOWN charge outcome "insufficient funds", and KEEPS the claim', async () => {
    // The defect this exists for: the Buzz client throws on ANY non-2xx and on a
    // network failure, and `mapError` collapses 401/403/408/429 and every 5xx into
    // one INTERNAL_SERVER_ERROR. Reporting that as a 400 told the viewer they were
    // broke after a debit that may have committed — AND, because the endpoint
    // refunds the daily-cap reservation on a 4xx, gave back the ceiling for Buzz
    // that DID move. A 5xx keeps the reservation.
    mockCreateMulti.mockRejectedValueOnce(buzzApiError(504, 'Gateway Timeout'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 503, reason: 'charge_unknown' });
    // 🔴 The `pending` row SURVIVES AS `pending`: it is the only record that a
    // debit may exist, and tombstoning it as `refunded` would assert a reversal
    // that never happened.
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.updateMany).not.toHaveBeenCalled();
    // And nothing is reversed — we cannot know what to reverse.
    expect(mockRefundMulti).not.toHaveBeenCalled();
    // The outcome is UNKNOWN and no verdict was reached, so the caller must
    // neither return the cap reservation nor cache this.
    expect(result).toMatchObject({ charge: 'unknown', retryable: true });
  });

  it('only a 400 can reach the insufficient_funds arm — pins it to knownPreMoney', async () => {
    // The `insufficient_funds` arm is the ternary's `else`, so it LOOKS like it
    // catches every unlisted status. It cannot: `refusal` is returned only
    // inside `if (knownPreMoney)`, and that predicate lists 400/409/404. The
    // safety is therefore a COUPLING between two expressions, not a property of
    // either — widen `knownPreMoney` by one status and that status silently
    // acquires "you do not have enough Buzz", which on an attempt whose ledger
    // effect is unknown is the one message that invites a double-charge.
    //
    // Statuses chosen to straddle the predicate: 402 and 422 are 4xx that are
    // NOT in it (the shape a future widening would add), 500 is a 5xx. None may
    // yield a funds verdict today.
    for (const status of [402, 422, 500]) {
      mockCreateMulti.mockRejectedValueOnce(buzzApiError(status, `status ${status}`));
      const result = await purchaseBlockGood(purchaseInput());
      expect(result, `status ${status} must not claim a funds verdict`).toMatchObject({
        ok: false,
        reason: 'charge_unknown',
      });
    }
    // POSITIVE CONTROL: the arm is reachable, so the loop above is not passing
    // because nothing can ever reach it.
    mockCreateMulti.mockRejectedValueOnce(buzzApiError(400, 'Insufficient funds'));
    expect(await purchaseBlockGood(purchaseInput())).toMatchObject({
      ok: false,
      reason: 'insufficient_funds',
    });
  });

  it('treats a throw with NO recognisable buzz status as UNKNOWN, not as a refusal', async () => {
    // A raw `fetch` failure or an abort never reaches `mapError` at all, so
    // `getBuzzApiStatus` returns undefined. Fail-safe means UNKNOWN, not 400.
    mockCreateMulti.mockRejectedValueOnce(new Error('socket hang up'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 503, reason: 'charge_unknown' });
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses when the charge reports no transactions at all, reversing and TOMBSTONING', async () => {
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [],
      totalAmount: 0,
      transactionCount: 0,
    } as never);
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'charge_failed' });
    expect(mockCreateSingle).not.toHaveBeenCalled();
    expect(mockRefundMulti).toHaveBeenCalledTimes(1);
    // 🔴 KEPT, NOT DELETED. The reversal leaves this key occupied in the ledger
    // forever, so the row has to survive as the marker the retry supersedes.
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: expect.any(String), status: 'pending' },
        data: expect.objectContaining({ status: 'refunded' }),
      })
    );
  });

  it('🔴 refuses a PARTIAL debit rather than recording it as a full-price sale', async () => {
    // `transactionCount` alone does not say the whole price was taken. Recording
    // a short debit as a full sale pays the owner 70% of Buzz the viewer never
    // spent — the fixture total (600) is distinct from the price (1000) and from
    // both shares (700/300), so it cannot pass by coincidence.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [{ transactionId: 'buy-y', accountType: 'yellow', amount: 600 }],
      totalAmount: 600,
      transactionCount: 1,
    } as never);
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 400, reason: 'charge_failed' });
    expect(mockCreateSingle).not.toHaveBeenCalled();
    expect(mockRefundMulti).toHaveBeenCalledTimes(1);
  });

  it('accepts a price at EXACTLY the hard cap', async () => {
    // Boundary control for the over-cap refusal: a `>=` mutant would make a good
    // a moderator approved at the ceiling permanently unbuyable.
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        {
          transactionId: 'buy-y',
          accountType: 'yellow',
          amount: BLOCK_GOOD_MAX_PRICE_BUZZ,
        },
      ],
      totalAmount: BLOCK_GOOD_MAX_PRICE_BUZZ,
      transactionCount: 1,
    } as never);
    const result = await purchaseBlockGood(
      purchaseInput({
        resolved: { ...RESOLVED, good: { ...GOOD, priceBuzz: BLOCK_GOOD_MAX_PRICE_BUZZ } },
      })
    );
    expect(result.ok).toBe(true);
  });

  it('REVERSES the charge and TOMBSTONES the claim when the settle fails', async () => {
    dbMock.dbWrite.$transaction.mockRejectedValueOnce(new Error('db down'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result).toMatchObject({ ok: false, status: 500, reason: 'charge_failed' });
    // Safe as a PREFIX-wide reversal only because this attempt holds the claim
    // exclusively — which is the property the claim-before-charge order buys.
    expect(mockRefundMulti).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: BUY_KEY,
      })
    );
    expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodPurchase.updateMany).toHaveBeenCalledTimes(1);
    expect(mockCreateSingle).not.toHaveBeenCalled();
  });

  /**
   * A FAILED reversal, at each of the two sites that attempt one.
   *
   * 🔴 THE DEFECT, AND IT WAS A REGRESSION. `rollbackCharge` returned
   * `Promise<void>` and only LOGGED its failure, so a refused reversal resolved
   * indistinguishably from a successful one and both callers went on to
   * tombstone the row and report `charge: 'reversed'`. All three things that
   * follow are wrong in that state:
   *   - the endpoint refunds the daily-cap reservation for Buzz that never
   *     came back (`charge: 'reversed'`);
   *   - the tombstone asserts a refund that did not happen, so
   *     `refundBlockGoodPurchase` answers `already_refunded` and the failure
   *     closes its own remediation path;
   *   - the retired key lets the next attempt open a FRESH generation and
   *     debit the buyer a second time, stranding the first debit.
   * It is the same thing `refundBlockGoodPurchase` already aborts on when the
   * BUYER refund fails, and says so in its own header.
   */
  describe('when the reversal itself is refused', () => {
    it('🔴 after a PARTIAL debit: no tombstone, no reversed claim, UNKNOWN outcome', async () => {
      mockCreateMulti.mockResolvedValueOnce({
        transactionIds: [{ transactionId: 'buy-y', accountType: 'yellow', amount: 600 }],
        totalAmount: 600,
        transactionCount: 1,
      } as never);
      mockRefundMulti.mockRejectedValueOnce(new Error('ledger unavailable'));

      const result = await purchaseBlockGood(purchaseInput());

      // The reversal was attempted — without this the assertions below would
      // also hold for an implementation that never tried.
      expect(mockRefundMulti).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        ok: false,
        status: 503,
        reason: 'charge_unknown',
        // NOT `reversed`: nothing established that the debit came back, so the
        // caller must keep the viewer's cap reservation.
        charge: 'unknown',
      });
      // 🔴 NO TOMBSTONE. `updateMany` is the only writer of the `refunded`
      // marker `newestSupersededPurchaseId` reads, so not writing it is
      // precisely what stops a retry opening a fresh generation on top of a
      // debit nobody has confirmed is gone. The row stays `pending`, which is
      // what the claim insert refuses as `pending_reconciliation`.
      expect(dbMock.dbWrite.blockGoodPurchase.updateMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
      expect(mockCreateSingle).not.toHaveBeenCalled();
    });

    it('🔴 after a failed SETTLE: the same, at the second call site', async () => {
      // Both sites are covered because the swallow was in the shared helper:
      // fixing one caller and not the other leaves the identical defect behind
      // a different failure.
      dbMock.dbWrite.$transaction.mockRejectedValueOnce(new Error('db down'));
      mockRefundMulti.mockRejectedValueOnce(new Error('ledger unavailable'));

      const result = await purchaseBlockGood(purchaseInput());

      expect(mockRefundMulti).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, status: 503, reason: 'charge_unknown' });
      expect(result).toMatchObject({ charge: 'unknown' });
      expect(dbMock.dbWrite.blockGoodPurchase.updateMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.blockGoodPurchase.deleteMany).not.toHaveBeenCalled();
    });
  });

  it('RE-GRANTS a revoked entitlement — clearing revokedAt, revokeReason and grantedAt', async () => {
    // 🔴 The `update` branch nothing asserted. Dropping `revokedAt: null` from it
    // leaves a viewer who was refunded and re-bought CHARGED, the owner PAID, and
    // the entitlement still revoked — so the read returns nothing they own, and a
    // third attempt is refused forever. Money in, nothing out.
    dbMock.dbRead.blockGoodEntitlement.findUnique.mockResolvedValue({
      goodId: GOOD_ID,
      kind: 'good',
      payload: {},
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      revokedAt: new Date('2026-09-20T00:00:00.000Z'),
      purchaseId: 'bgp_FIRST',
    });
    await purchaseBlockGood(purchaseInput());
    const upsert = dbMock.dbWrite.blockGoodEntitlement.upsert.mock.calls[0][0];
    expect(upsert.update).toEqual(
      expect.objectContaining({
        revokedAt: null,
        revokeReason: null,
        grantedAt: expect.any(Date),
        purchaseId: expect.any(String),
        kind: 'good',
      })
    );
    // …and it repoints at the NEW purchase, not the refunded one.
    expect(upsert.update.purchaseId).not.toBe('bgp_FIRST');
  });

  it('still completes the purchase when the owner PAYOUT fails', async () => {
    // The viewer paid; withholding the entitlement because the credit leg failed
    // would take their money and give nothing. The obligation is visible as an
    // empty `payouts` on the row.
    // `withRetries` re-attempts the whole payout block, so reject every attempt.
    mockCreateSingle.mockRejectedValue(new Error('bank unavailable'));
    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);
    // The SETTLE update fires (that is what makes the purchase real); the PAYOUT
    // update does not, so `payouts` stays `[]` — which is exactly the set a
    // re-runner would select. Asserted by the data shape, not the call count, so
    // a mutant writing an OPTIMISTIC payout before the credit lands is caught:
    // that row would claw back Buzz the owner never received.
    const updates = dbMock.dbWrite.blockGoodPurchase.update.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data
    );
    expect(updates).toEqual([{ status: 'paid', bluePaidBuzz: 0 }]);
    expect(updates.some((d) => 'payouts' in d)).toBe(false);
    expect(dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data.payouts).toEqual([]);
  });

  /**
   * A `createBuzzTransaction` that behaves like the LEDGER does: a duplicate
   * `externalTransactionId` is a 409 THROW, not a silent no-op.
   *
   * 🔴 THE MOCK IS THE POINT OF THESE TWO TESTS. The old fixture rejected every
   * attempt, so it could never build the partial-success shape, and the code's
   * own comment — "a retry after a partial success is deduped by the ledger
   * rather than double-paying" — went unchecked and was false: the client
   * throws on any non-2xx (`packages/civitai-buzz/src/client.ts`).
   */
  function stubLedgerPayouts(opts: { blipsPerColor: Partial<Record<string, number>> }) {
    const occupied = new Set<string>();
    const blips = { ...opts.blipsPerColor };
    mockCreateSingle.mockImplementation(async (input) => {
      const externalId = input.externalTransactionId as string;
      const color = input.toAccountType as string;
      if (occupied.has(externalId)) throw buzzApiError(409, 'Conflict');
      const remaining = blips[color] ?? 0;
      if (remaining > 0) {
        blips[color] = remaining - 1;
        throw new Error(`bank blip on ${color}`);
      }
      occupied.add(externalId);
      return { transactionId: `pay-${color}`, remainingBalance: null };
    });
  }

  /** A mixed-colour charge: 400 blue + 600 yellow, so the payout has two legs. */
  function stubMixedColorCharge() {
    mockCreateMulti.mockResolvedValueOnce({
      transactionIds: [
        { transactionId: 'buy-b', accountType: 'blue', amount: 400 },
        { transactionId: 'buy-y', accountType: 'yellow', amount: 600 },
      ],
      totalAmount: PRICE,
      transactionCount: 2,
    } as never);
  }

  it('🔴 sends the OWNER credits OUTSIDE the prefix the buyer’s debit is refunded by', async () => {
    // The OBSERVABLE half of the payout-id separation — measured on what the
    // service actually put on the wire, not on the helper that builds it, so it
    // is red at the audited head for the real reason rather than because a new
    // export is missing. There the legs were `${chargePrefix}:sell:…`, which put
    // the buyer's whole refund prefix inside every owner credit.
    stubMixedColorCharge();
    await purchaseBlockGood(purchaseInput());

    const chargePrefix = (
      mockCreateMulti.mock.calls[0][0] as {
        externalTransactionIdPrefix: string;
      }
    ).externalTransactionIdPrefix;
    const legIds = mockCreateSingle.mock.calls.map(
      (c) => (c[0] as { externalTransactionId: string }).externalTransactionId
    );
    // Positive control on the fixture: two legs, or the disjointness below is
    // being asserted over nothing.
    expect(legIds).toHaveLength(2);
    expect(prefixPairs([chargePrefix, ...legIds])).toEqual([]);
  });

  it('🔴 CONVERGES when one payout leg lands and the other blips', async () => {
    // 🔴 THE DEFECT. `withRetries` re-runs the WHOLE payout closure, so the
    // landed blue leg was re-sent on every attempt, collided with its own
    // external id, threw, and killed the attempt before the yellow leg was
    // reached. Every attempt failed, `payouts` stayed `[]`, and a later refund
    // read `readRecordedPayouts([])` and clawed back NOTHING while refunding
    // the buyer in full — the owner keeps 700 Buzz of a reversed sale.
    stubMixedColorCharge();
    stubLedgerPayouts({ blipsPerColor: { yellow: 1 } });

    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);

    // 🔴 BLUE IS SENT EXACTLY ONCE. This is the narrow property: a retry must
    // skip what it already landed. Counting total calls instead would pass on
    // an implementation that re-sent blue and swallowed the conflict.
    const byColor = mockCreateSingle.mock.calls.map(
      (c) => (c[0] as { toAccountType: string }).toAccountType
    );
    expect(byColor.filter((c) => c === 'blue')).toHaveLength(1);
    expect(byColor.filter((c) => c === 'yellow')).toHaveLength(2);

    // …and BOTH legs are recorded, with the ids a refund will reverse. 280/420
    // are the proration of 700 against a 400-blue charge, distinct from the
    // price (1000) and from both shares (700/300).
    const payoutWrite = dbMock.dbWrite.blockGoodPurchase.update.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => 'payouts' in d);
    expect(payoutWrite?.payouts).toEqual([
      { userId: OWNER, amount: 280, color: 'blue', transactionId: 'pay-blue' },
      { userId: OWNER, amount: 420, color: 'yellow', transactionId: 'pay-yellow' },
    ]);
  });

  it('🔴 RECORDS the leg that landed even when the payout never completes', async () => {
    // The other half: if yellow never recovers, the blue leg still has to reach
    // `payouts`, because a refund reverses what is recorded and nothing else.
    // An unrecorded landed leg is Buzz the owner keeps after the buyer is made
    // whole. `withRetries(fn, 3)` makes four attempts, so four blips exhaust it.
    stubMixedColorCharge();
    stubLedgerPayouts({ blipsPerColor: { yellow: 4 } });

    const result = await purchaseBlockGood(purchaseInput());
    // The viewer keeps their entitlement: a failed credit leg is an obligation
    // to re-run, never a reason to fail a purchase whose money already moved.
    expect(result.ok).toBe(true);

    expect(mockCreateSingle.mock.calls.filter((c) => c[0].toAccountType === 'blue')).toHaveLength(
      1
    );
    const payoutWrite = dbMock.dbWrite.blockGoodPurchase.update.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => 'payouts' in d);
    expect(payoutWrite?.payouts).toEqual([
      { userId: OWNER, amount: 280, color: 'blue', transactionId: 'pay-blue' },
    ]);
  });

  it('leaves a PARTIAL payout distinguishable from a complete one (INVARIANT GUARD)', async () => {
    // INVARIANT GUARD, not regression coverage: nothing today reads this, and
    // the arithmetic below already held at the audited head. It is pinned
    // because the PR asserts a re-run selector as the design and the obvious
    // spelling of it — `payouts = []` — misses exactly the rows where money is
    // owed. A partial payout is non-empty, so the marker has to be the
    // SHORTFALL against the row's own `app_owner_share_buzz`, which needs no
    // new column. What this guards is that relationship: a mutant recording
    // the full share optimistically, or writing legs that do not sum to it,
    // makes complete and partial indistinguishable again.
    const recordedSum = async (blipYellow: number) => {
      vi.clearAllMocks();
      for (const mock of [mockCreateMulti, mockCreateSingle, mockRefundMulti]) mock.mockReset();
      stubCleanDb();
      stubMixedColorCharge();
      stubLedgerPayouts({ blipsPerColor: { yellow: blipYellow } });
      await purchaseBlockGood(purchaseInput());
      const share = dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data
        .appOwnerShareBuzz as number;
      const payouts = (dbMock.dbWrite.blockGoodPurchase.update.mock.calls
        .map((c) => (c[0] as { data: Record<string, unknown> }).data)
        .find((d) => 'payouts' in d)?.payouts ?? []) as { amount: number }[];
      return { share, sum: payouts.reduce((t, p) => t + p.amount, 0) };
    };

    // `withRetries(fn, 3)` makes four attempts, so four blips exhaust it and
    // only the blue leg lands.
    const partial = await recordedSum(4);
    const complete = await recordedSum(0);

    // The two sums are 280 and 700 — distinct from each other, from the price
    // (1000) and from the platform share (300), so neither can match by
    // coincidence.
    expect(partial.sum).toBe(280);
    expect(complete.sum).toBe(700);
    expect(partial.share).toBe(complete.share);
    // The property itself, stated against the column rather than the literals:
    expect(complete.sum).toBe(complete.share);
    expect(partial.sum).toBeLessThan(partial.share);
  });

  it('records a leg the ledger reports as ALREADY PAID, without inventing an id for it', async () => {
    // A 409 on a credit leg means an earlier attempt landed it and we lost the
    // response. It is recorded WITHOUT a transaction id, which is the shape
    // `refundBlockGoodPurchase` already reports in `failures` for a human —
    // rather than dropped, which would understate what the owner was paid.
    stubMixedColorCharge();
    // Keyed on the COLOUR, not on the id this scheme happens to produce, so the
    // test exercises the 409 branch rather than restating the id format.
    mockCreateSingle.mockImplementation(async (input) => {
      if (input.toAccountType === 'blue') throw buzzApiError(409, 'Conflict');
      return { transactionId: 'pay-yellow', remainingBalance: null };
    });

    const result = await purchaseBlockGood(purchaseInput());
    expect(result.ok).toBe(true);

    const payoutWrite = dbMock.dbWrite.blockGoodPurchase.update.mock.calls
      .map((c) => (c[0] as { data: Record<string, unknown> }).data)
      .find((d) => 'payouts' in d);
    expect(payoutWrite?.payouts).toEqual([
      // No `transactionId` key at all — not an empty string, which
      // `readRecordedPayouts` would also drop but which would read as a value.
      { userId: OWNER, amount: 280, color: 'blue' },
      { userId: OWNER, amount: 420, color: 'yellow', transactionId: 'pay-yellow' },
    ]);
  });

  it('records a NULL block instance rather than failing when it is unresolvable', async () => {
    const result = await purchaseBlockGood(purchaseInput({ blockInstanceId: null }));
    expect(result.ok).toBe(true);
    expect(
      dbMock.dbWrite.blockGoodPurchase.create.mock.calls[0][0].data.blockInstanceId
    ).toBeNull();
  });
});

describe('listBlockGoodEntitlements — visible only to the owning app', () => {
  it('scopes the query to the CALLING app and the viewer, and excludes revoked rows', async () => {
    dbMock.dbRead.blockGoodEntitlement.findMany.mockResolvedValue([
      {
        goodId: GOOD_ID,
        kind: 'good',
        payload: { slots: 5 },
        grantedAt: new Date('2026-09-27T00:00:00.000Z'),
      },
    ]);
    const rows = await listBlockGoodEntitlements({ userId: BUYER, appBlockId: APP_BLOCK_ID });
    expect(dbMock.dbRead.blockGoodEntitlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: BUYER, appBlockId: APP_BLOCK_ID, revokedAt: null },
      })
    );
    expect(rows).toEqual([
      {
        goodId: GOOD_ID,
        kind: 'good',
        payload: { slots: 5 },
        grantedAt: '2026-09-27T00:00:00.000Z',
      },
    ]);
  });

  it('asks for a DIFFERENT app id when a different app calls', async () => {
    // The scoping is in the query, so the only way an app sees another app's
    // entitlements is if this argument stops reaching the `where`.
    await listBlockGoodEntitlements({ userId: BUYER, appBlockId: 'apb_OTHERAPP' });
    expect(dbMock.dbRead.blockGoodEntitlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ appBlockId: 'apb_OTHERAPP' }),
      })
    );
  });
});

describe('refundBlockGoodPurchase — reverses the RECORDED payout', () => {
  const RECORDED = [
    { userId: OWNER, amount: 280, color: 'blue', transactionId: 'pay-blue' },
    { userId: OWNER, amount: 420, color: 'yellow', transactionId: 'pay-yellow' },
  ];

  function stubPurchase(overrides: Record<string, unknown> = {}) {
    dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue({
      id: 'bgp_1',
      status: 'paid',
      userId: BUYER,
      appBlockId: APP_BLOCK_ID,
      goodId: GOOD_ID,
      priceBuzz: PRICE,
      buzzTransactionId: BUY_KEY,
      payouts: RECORDED,
      ...overrides,
    });
  }

  it('refunds the buyer and reverses EXACTLY the recorded payout transactions', async () => {
    stubPurchase();
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });

    expect(result).toMatchObject({ refunded: true, clawedBackBuzz: 700, failures: [] });
    expect(mockRefundMulti).toHaveBeenCalledWith(
      expect.objectContaining({
        externalTransactionIdPrefix: BUY_KEY,
      })
    );
    expect(mockRefundTransaction.mock.calls.map((c) => c[0])).toEqual(['pay-blue', 'pay-yellow']);
  });

  it('does NOT re-derive the split — a payout that differs from 70/30 is reversed as recorded', async () => {
    // 🔴 THE POINT OF THE `payouts` COLUMN. These amounts (500 + 100) are NOT
    // `computeBlockGoodSplit(1000)`, so a re-deriving implementation would claw
    // back 700 and the assertion below would see the wrong total. The fixture
    // values are deliberately distinct from 700, 300 and 1000.
    stubPurchase({
      payouts: [
        { userId: OWNER, amount: 500, color: 'yellow', transactionId: 'legacy-a' },
        { userId: OWNER, amount: 100, color: 'blue', transactionId: 'legacy-b' },
      ],
    });
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'chargeback' });
    expect(result).toMatchObject({ refunded: true, clawedBackBuzz: 600 });
    expect(mockRefundTransaction.mock.calls.map((c) => c[0])).toEqual(['legacy-a', 'legacy-b']);
  });

  it('REVOKES the entitlement and marks the purchase refunded', async () => {
    stubPurchase();
    await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });
    expect(dbMock.dbWrite.blockGoodPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'bgp_1' },
        data: expect.objectContaining({ status: 'refunded', refundReason: 'takedown' }),
      })
    );
    expect(dbMock.dbWrite.blockGoodEntitlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purchaseId: 'bgp_1', revokedAt: null },
        data: expect.objectContaining({ revokeReason: 'takedown' }),
      })
    );
  });

  it('REPORTS a payout with no recorded transaction id instead of guessing at it', async () => {
    stubPurchase({ payouts: [{ userId: OWNER, amount: 700, color: 'yellow' }] });
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });
    expect(result).toMatchObject({ refunded: true, clawedBackBuzz: 0 });
    expect((result as { failures: string[] }).failures[0]).toContain('no recorded transaction id');
    expect(mockRefundTransaction).not.toHaveBeenCalled();
  });

  it('🔴 ABORTS when the BUYER refund fails — it must not record a refund that did not happen', async () => {
    // The worst outcome this function can produce, and it was reachable: marking
    // the row `refunded` after a failed buyer refund loses the viewer the item
    // AND the money, asserts in the record that they were repaid, and then
    // `already_refunded` refuses every retry — so the failure closes its own
    // remediation path.
    stubPurchase();
    mockRefundMulti.mockRejectedValueOnce(new Error('ledger unavailable'));
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });
    expect(result).toEqual({ refunded: false, reason: 'buyer_refund_failed' });
    // The purchase stays `paid` and the entitlement stays granted — a state a
    // retry can act on.
    expect(dbMock.dbWrite.blockGoodPurchase.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.blockGoodEntitlement.updateMany).not.toHaveBeenCalled();
    // And the owner is NOT clawed back for a refund the viewer never received.
    expect(mockRefundTransaction).not.toHaveBeenCalled();
  });

  it('reports a failed clawback rather than claiming the money came back', async () => {
    stubPurchase();
    mockRefundTransaction.mockRejectedValueOnce(new Error('ledger down'));
    const result = await refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'takedown' });
    expect(result).toMatchObject({ refunded: true, clawedBackBuzz: 420 });
    expect((result as { failures: string[] }).failures).toHaveLength(1);
  });

  it('refuses a purchase that is already refunded, and one that does not exist', async () => {
    stubPurchase({ status: 'refunded' });
    await expect(
      refundBlockGoodPurchase({ purchaseId: 'bgp_1', reason: 'again' })
    ).resolves.toEqual({ refunded: false, reason: 'already_refunded' });

    dbMock.dbWrite.blockGoodPurchase.findUnique.mockResolvedValue(null);
    await expect(refundBlockGoodPurchase({ purchaseId: 'nope', reason: 'x' })).resolves.toEqual({
      refunded: false,
      reason: 'not_found',
    });
    expect(mockRefundMulti).not.toHaveBeenCalled();
  });
});

describe('readRecordedPayouts — narrowing the JSON column', () => {
  it('keeps well-formed entries and drops anything it cannot trust', () => {
    expect(
      readRecordedPayouts([
        { userId: 1, amount: 10, color: 'blue', transactionId: 't' },
        { userId: 2, amount: 20, color: 'yellow' },
        { userId: 'three', amount: 30, color: 'yellow' },
        { userId: 4, amount: '40', color: 'yellow' },
        { userId: 5, amount: 50 },
        null,
        'nope',
      ])
    ).toEqual([
      { userId: 1, amount: 10, color: 'blue', transactionId: 't' },
      { userId: 2, amount: 20, color: 'yellow' },
    ]);
  });

  it('returns an empty list for a non-array value', () => {
    for (const value of [null, undefined, {}, 'x', 7]) {
      expect(readRecordedPayouts(value)).toEqual([]);
    }
  });
});

describe('owesOwnerPayout — the owner-payout RE-RUN SET', () => {
  /**
   * 🔴 WHY THIS IS CODE AND NOT A COMMENT. The re-run set lived as prose on
   * `payBlockGoodOwner` and was restated in a second comment, and the restating
   * widened it: a bare `sum(payouts[].amount) < app_owner_share_buzz` with no
   * status test. `BLOCK_GOOD_MIN_PRICE_BUZZ` is 2, so the owner's share is at
   * least 1 on every priced good and `0 < share` holds unconditionally — the
   * bare test selects every row that never paid, including three classes that
   * must never be paid. Each is a case below.
   *
   * INVARIANT GUARD, not regression coverage: no re-runner exists, so nothing
   * has ever behaved either way. What it pins is the predicate a re-runner will
   * call, in the one place it is written.
   *
   * The payout totals used here are 0, 280, 700 and 900 — below the share,
   * equal to it, and above it — so the comparison is pinned on BOTH sides of
   * its boundary rather than only from below. The two that are not the share
   * are also distinct from the price (1000), so no case can pass by
   * coincidence; 700 coincides with the share deliberately, as the equality
   * boundary.
   */
  const SHARE = 700;
  const partial = [{ userId: OWNER, amount: 280, color: 'blue' }];
  const complete = [
    { userId: OWNER, amount: 280, color: 'blue' },
    { userId: OWNER, amount: 420, color: 'yellow' },
  ];

  it('SELECTS a paid row whose payouts fall short, and one that paid nothing', () => {
    // The set's whole purpose: a partial payout is invisible on the row
    // otherwise, and an owner underpaid by a leg has nothing saying so.
    expect(owesOwnerPayout({ status: 'paid', payouts: partial, appOwnerShareBuzz: SHARE })).toBe(
      true
    );
    expect(owesOwnerPayout({ status: 'paid', payouts: [], appOwnerShareBuzz: SHARE })).toBe(true);
  });

  it('does NOT select a paid row whose payouts sum to the full share', () => {
    // Boundary control. A `<=` mutant would re-pay every completed purchase.
    expect(owesOwnerPayout({ status: 'paid', payouts: complete, appOwnerShareBuzz: SHARE })).toBe(
      false
    );
  });

  it('🔴 does NOT select a paid row that was OVERPAID — the re-pay LOOP a `!==` spelling opens', () => {
    // 🔴 The other side of the boundary, and the reason `<` is not
    // interchangeable with "not yet settled". The case above pins the boundary
    // POINT (sum == share, which a `<=` mutant would wrongly select); nothing
    // pinned the region ABOVE it, so `paidSoFar !== share` passed the whole
    // suite. Under that spelling an overpaid row stays selected no matter what
    // a re-runner does to it: paying again only moves the sum FURTHER from the
    // share, so it is selected again — an unbounded re-pay loop, money out.
    // `<` terminates by construction: at or past the share it never selects
    // again, whatever it overshot by.
    //
    // How a row gets here is not asserted, because nothing writes one today —
    // the legs are built to sum to exactly the share. That is what makes this
    // a bound on the PREDICATE rather than a claim about the data.
    expect(
      owesOwnerPayout({
        status: 'paid',
        payouts: [{ userId: OWNER, amount: 900, color: 'blue' }],
        appOwnerShareBuzz: SHARE,
      })
    ).toBe(false);
  });

  it('🔴 does NOT select a REFUNDED row that had already been PARTIALLY paid', () => {
    // 🔴 The class the widened spelling admitted, and the reason the status
    // test is not decoration. `refundBlockGoodPurchase` claws the payout back
    // and marks the row refunded but LEAVES `payouts` intact — it is the record
    // of what a clawback reversed. So `280 < 700` reads true on this row
    // forever, and a shortfall-only selector would pay the owner again for a
    // purchase the buyer was refunded.
    expect(
      owesOwnerPayout({ status: 'refunded', payouts: partial, appOwnerShareBuzz: SHARE })
    ).toBe(false);
  });

  it('🔴 does NOT select a `refunded` TOMBSTONE, whose debit was reversed', () => {
    // `voidReversedClaim` writes this shape: refunded, nothing ever paid out.
    // The buyer's Buzz went back, so the owner is owed nothing at all.
    expect(owesOwnerPayout({ status: 'refunded', payouts: [], appOwnerShareBuzz: SHARE })).toBe(
      false
    );
  });

  it('🔴 does NOT select a `pending` row, whose debit is not confirmed', () => {
    // A row is INSERTED `pending` before the buyer is charged, and survives an
    // UNKNOWN charge outcome. Paying its owner credits money that may never
    // have moved.
    expect(owesOwnerPayout({ status: 'pending', payouts: [], appOwnerShareBuzz: SHARE })).toBe(
      false
    );
  });

  it('reads the payouts column through the same narrowing a refund uses', () => {
    // A malformed leg is DROPPED, not summed — so a row whose only record is
    // untrustworthy is still owed. Pinned because a re-runner that summed the
    // raw JSON would disagree with the refund path about what was paid.
    expect(
      owesOwnerPayout({
        status: 'paid',
        payouts: [{ userId: OWNER, amount: '700', color: 'blue' }],
        appOwnerShareBuzz: SHARE,
      })
    ).toBe(true);
  });
});
