import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The currency a comic-chapter early-access purchase moves comes from the
 * REQUEST'S DOMAIN, on BOTH legs.
 *
 * `toAccountType` is optional in the buzz schema and the service silently
 * defaults it to `'yellow'`, so omitting it compiles, type-checks and passes
 * every other test in the repo while paying green buyers' creators in yellow.
 * Only an assertion on the argument handed to the buzz service can tell an
 * omitted destination from a domain-derived one.
 */

import type * as BuzzService from '~/server/services/buzz.service';
import type * as CommonService from '~/server/services/common.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';

const BUYER = 111;
const CREATOR = 222;
const CHAPTER_ID = 333;
const PRICE = 500;

// A charge response the REAL service could have returned — pinned against its
// own zod schema below. A short shape here would make "the charge happened"
// indistinguishable from "the charge moved nothing", and the router branches on
// `transactionCount`.
const CHARGE_RESPONSE = {
  transactionIds: [{ transactionId: 'tx-1', accountType: 'user', amount: PRICE }],
  totalAmount: PRICE,
  transactionCount: 1,
};

const {
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
  hasEntityAccess,
  findUnique,
  entityAccessCreate,
} = vi.hoisted(() => ({
  createMultiAccountBuzzTransaction: vi.fn(),
  refundMultiAccountTransaction: vi.fn(async () => ({ refundedTransactions: [] })),
  hasEntityAccess: vi.fn(async () => [
    { entityId: 333, entityType: 'ComicChapter', hasAccess: false },
  ]),
  findUnique: vi.fn(),
  entityAccessCreate: vi.fn(async () => ({})),
}));

// Spread the real modules and override only the writers: a hand-listed factory
// would couple this file to every export the 5k-line router happens to import.
vi.mock('~/server/services/buzz.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzService>()),
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
}));
vi.mock('~/server/services/common.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CommonService>()),
  hasEntityAccess,
}));
// `isFlagProtected` recomputes flags from the request rather than reading
// `ctx.features`, which would reach Flipt. The currency itself is NOT taken from
// here — the router reads `ctx.features` directly — so this cannot fake the
// property under test.
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlags: (ctx: { features?: unknown }) => ctx.features,
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { comicChapter: { findUnique } },
  dbWrite: {
    $transaction: (cb: (tx: unknown) => unknown) =>
      cb({ entityAccess: { create: entityAccessCreate } }),
  },
}));

import { comicsRouter } from '~/server/routers/comics.router';
import { createMultiAccountBuzzTransactionResponse } from '~/server/schema/buzz.schema';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Availability, ComicChapterStatus } from '~/shared/utils/prisma/enums';

const chapter = {
  id: CHAPTER_ID,
  name: 'Chapter One',
  availability: Availability.EarlyAccess,
  earlyAccessConfig: { buzzPrice: PRICE, timeframe: 3 },
  earlyAccessEndsAt: new Date(Date.now() + 86_400_000),
  status: ComicChapterStatus.Published,
  project: { id: 9, name: 'A Comic', userId: CREATOR },
};

const callerOn = (isGreen: boolean) =>
  comicsRouter.createCaller({
    user: { id: BUYER, isModerator: false },
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    features: { isGreen, comicCreator: true, canViewNsfw: !isGreen },
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(chapter);
  createMultiAccountBuzzTransaction.mockResolvedValue(CHARGE_RESPONSE);
});

describe('comics router — early access moves ONE currency, the domain’s', () => {
  it('drives the router with a charge response the real service could return', () => {
    expect(() => createMultiAccountBuzzTransactionResponse.parse(CHARGE_RESPONSE)).not.toThrow();
  });

  it.each([
    ['green', 'green', true],
    ['mature', 'yellow', false],
  ] as const)('charges and pays a %s-domain purchase in %s Buzz', async (_, expected, isGreen) => {
    await expect(
      callerOn(isGreen).purchaseChapterAccess({ chapterId: CHAPTER_ID })
    ).resolves.toEqual({ success: true });

    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        fromAccountId: BUYER,
        toAccountId: CREATOR,
        amount: PRICE,
        fromAccountTypes: [expected],
        toAccountType: expected,
      })
    );
    // A charge that rolled back looks identical to one that stuck unless the
    // grant and the absence of a refund are both pinned.
    expect(entityAccessCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accessToId: CHAPTER_ID, accessorId: BUYER }),
      })
    );
    expect(refundMultiAccountTransaction).not.toHaveBeenCalled();
  });

  // The input schema is `z.object({ chapterId })`, so unknown keys are stripped
  // — but that is a property of a file this one does not own, and a widened
  // schema would let a buyer name the currency their creator is paid in.
  it('ignores a client-supplied currency on a green request', async () => {
    await callerOn(true).purchaseChapterAccess({
      chapterId: CHAPTER_ID,
      spendType: 'yellow',
      toAccountType: 'yellow',
      fromAccountTypes: ['yellow'],
    } as never);

    expect(createMultiAccountBuzzTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ fromAccountTypes: ['green'], toAccountType: 'green' })
    );
  });
});
