import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * What `getPackDetail` returns is decided here, field by field.
 *
 * The decision: the endpoint names the fields a pack page renders rather than
 * returning `meta`, which is one JSON blob shared with submission, payout and
 * review bookkeeping. A field-level pick keeps a later addition to that blob
 * from becoming a change to this response by default — which is the part a
 * one-off deletion would not have bought.
 *
 * If you are widening this back, the guard in
 * `src/components/CreatorShop/Pack/__tests__/moderator-pack-edit-route.test.ts`
 * is the other half: the editor's rejected-vs-archived split was moved onto
 * `lastReviewWasRejection` for the same reason, not because the helper it used
 * was wrong.
 */

const shopItemFindUnique = vi.fn();
const shopItemFindMany = vi.fn();
const packMemberFindMany = vi.fn();
const ownedFindMany = vi.fn();
const purchaseGroupBy = vi.fn();
const resaleFindMany = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: {
      findUnique: (...a: unknown[]) => shopItemFindUnique(...a),
      findMany: (...a: unknown[]) => shopItemFindMany(...a),
    },
    cosmeticShopItemCosmetic: { findMany: (...a: unknown[]) => packMemberFindMany(...a) },
    userCosmeticShopPurchaseCosmetic: { groupBy: (...a: unknown[]) => purchaseGroupBy(...a) },
    userCosmetic: { findMany: (...a: unknown[]) => ownedFindMany(...a) },
    userCosmeticShopItemResale: { findMany: (...a: unknown[]) => resaleFindMany(...a) },
  },
  dbWrite: {
    userCosmetic: { findMany: (...a: unknown[]) => ownedFindMany(...a) },
  },
}));

const { getPackDetail } = await import('~/server/services/creator-shop-pack.service');

const PACK_ID = 6101;
const LISTER = 801;
const VISITOR = 802;
const MEMBER = 4101;
const MODERATOR_ID = 70099;

// Sentinels rather than plausible values: each is asserted absent from the
// serialized response, and a realistic number (a price, a small id) can match
// somewhere legitimate and turn that assertion into a false red.
const FEE_SENTINEL = 70011;
const APPROVED_AMOUNT_SENTINEL = 70012;
const PAYEE_SENTINEL = 70013;
const MEMBER_LISTING_SENTINEL = 'member-listing-bookkeeping-70020';

const cosmetic = {
  id: MEMBER,
  name: 'Badge',
  type: CosmeticType.Badge,
  data: { url: 'img' },
  createdById: LISTER,
  creator: { username: 'lister' },
};

// The fields a pack page renders, in the same blob as the bookkeeping it does
// not. Both halves are populated so the assertions below can tell them apart.
const META = {
  purchases: 3,
  coverUrl: 'cover.png',
  coverTiles: ['a.png'],
  packMemberCount: 1,
  acceptsBlueBuzz: true,
  submissionTxId: 'tx-sentinel-70014',
  submissionFee: FEE_SENTINEL,
  lastApprovedAmount: APPROVED_AMOUNT_SENTINEL,
  paidToUserIds: [PAYEE_SENTINEL],
  imageHash: 'hash-sentinel-70015',
  rightsAffirmation: {
    userId: LISTER,
    affirmedAt: 'then',
    version: 1,
    statement: 'statement-sentinel-70016',
  },
  takedown: { reason: 'reason-sentinel-70017', moderatorId: MODERATOR_ID, at: 'then' },
  history: [
    {
      at: 'then',
      userId: MODERATOR_ID,
      kind: 'reviewed',
      status: CosmeticShopItemStatus.Published,
      action: 'approve',
      note: 'note-sentinel-70018',
    },
  ],
};

// Everything the fixture puts in meta that the pack page does not render, by
// value. A field added to the blob and passed through shows up here as a
// failure rather than as silence.
const WITHHELD = [
  'note-sentinel-70018',
  'reason-sentinel-70017',
  'tx-sentinel-70014',
  'hash-sentinel-70015',
  'statement-sentinel-70016',
  MEMBER_LISTING_SENTINEL,
  String(MODERATOR_ID),
  String(FEE_SENTINEL),
  String(APPROVED_AMOUNT_SENTINEL),
  String(PAYEE_SENTINEL),
];

beforeEach(() => {
  vi.clearAllMocks();
  shopItemFindUnique.mockResolvedValue({
    id: PACK_ID,
    cosmeticId: null,
    title: 'A pack',
    description: null,
    unitAmount: 8800,
    status: CosmeticShopItemStatus.Published,
    listed: true,
    availableQuantity: null,
    meta: META,
    addedById: LISTER,
    members: [{ cosmeticId: MEMBER, floorAmount: 2600 }],
  });
  packMemberFindMany.mockResolvedValue([{ cosmeticId: MEMBER, floorAmount: 2600, cosmetic }]);
  shopItemFindMany.mockResolvedValue([
    {
      id: 9101,
      cosmeticId: MEMBER,
      unitAmount: 2600,
      // A member's own listing carries the same kind of bookkeeping the pack's
      // does. Populated because the members array is the other way this
      // response could carry it.
      meta: { purchases: 0, submissionTxId: MEMBER_LISTING_SENTINEL },
      addedById: LISTER,
      availableQuantity: null,
      availableFrom: null,
      availableTo: null,
      _count: { purchases: 0 },
      cosmetic,
    },
  ]);
  ownedFindMany.mockResolvedValue([]);
  purchaseGroupBy.mockResolvedValue([]);
  resaleFindMany.mockResolvedValue([]);
});

describe('public pack detail returns named fields, not the meta column', () => {
  it('returns only the meta fields the pack page renders', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID });
    // The listing, not a subset check: a new key here is a decision about what
    // the endpoint publishes, and this is where it gets made.
    expect(Object.keys(detail.meta).sort()).toEqual([
      'acceptsBlueBuzz',
      'coverTiles',
      'coverUrl',
      'packMemberCount',
      'purchases',
    ]);
  });

  it('returns only the top-level fields the pack page renders', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID });
    // The meta listing above fences one sub-object. This fences the response,
    // so a field lifted out of the blob to the top level fails too.
    expect(Object.keys(detail).sort()).toEqual([
      'amountDue',
      'availableQuantity',
      'description',
      'discount',
      'id',
      'isPackCreator',
      'lastReviewWasRejection',
      'listed',
      'members',
      'meta',
      'selfAuthored',
      'status',
      'title',
      'unavailableCount',
      'unitAmount',
    ]);
  });

  it('still carries what the pack page renders', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID });
    expect(detail.meta).toEqual({
      coverUrl: 'cover.png',
      coverTiles: ['a.png'],
      packMemberCount: 1,
      acceptsBlueBuzz: true,
      purchases: 3,
    });
  });

  it('holds back submission, payout and review bookkeeping from every caller', async () => {
    for (const caller of [
      { shopItemId: PACK_ID },
      { shopItemId: PACK_ID, userId: VISITOR },
      { shopItemId: PACK_ID, userId: LISTER },
      { shopItemId: PACK_ID, userId: MODERATOR_ID, isModerator: true },
    ]) {
      const detail = await getPackDetail(caller);
      // Serialized, because what reaches the wire is the question — a copy
      // nested under some other key counts the same as a top-level one.
      const wire = JSON.stringify(detail);
      for (const withheld of WITHHELD)
        expect(wire, `${withheld} must not reach a pack detail response`).not.toContain(withheld);
    }
  });

  it('answers the review verdict only for the lister and for moderators', async () => {
    expect(
      (await getPackDetail({ shopItemId: PACK_ID })).lastReviewWasRejection,
      'an anonymous caller gets no answer, not a false one'
    ).toBeUndefined();
    expect(
      (await getPackDetail({ shopItemId: PACK_ID, userId: VISITOR })).lastReviewWasRejection
    ).toBeUndefined();
    expect(
      (await getPackDetail({ shopItemId: PACK_ID, userId: LISTER })).lastReviewWasRejection
    ).toBe(false);
    expect(
      (await getPackDetail({ shopItemId: PACK_ID, userId: MODERATOR_ID, isModerator: true }))
        .lastReviewWasRejection
    ).toBe(false);
  });

  it('reports a rejection to the lister when the last verdict rejected', async () => {
    shopItemFindUnique.mockResolvedValue({
      id: PACK_ID,
      cosmeticId: null,
      title: 'A pack',
      description: null,
      unitAmount: 8800,
      status: CosmeticShopItemStatus.Archived,
      listed: false,
      availableQuantity: null,
      meta: {
        ...META,
        history: [
          { at: 'then', userId: MODERATOR_ID, kind: 'reviewed', action: 'approve' },
          { at: 'later', userId: MODERATOR_ID, kind: 'edited' },
          {
            at: 'later still',
            userId: MODERATOR_ID,
            kind: 'reviewed',
            action: 'reject',
            note: 'note-sentinel-70018',
          },
        ],
      },
      addedById: LISTER,
      members: [{ cosmeticId: MEMBER, floorAmount: 2600 }],
    });
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: LISTER });
    expect(detail.lastReviewWasRejection).toBe(true);
    // The verdict, not the presence of entries: the last entry here is not a
    // review, and the approve arm is the test above.
    expect(JSON.stringify(detail)).not.toContain('note-sentinel-70018');
  });
});

describe('the rejection verdict is derived once, on the server', () => {
  const serviceSource = readFileSync(
    path.join(process.cwd(), 'src/server/services/creator-shop-pack.service.ts'),
    'utf-8'
  );

  // The rule itself — the last reviewed entry, and whether its action rejected
  // — used to live in the client. Moving it here is only a move while it still
  // goes through the one helper; restated, it is a second copy in a new place,
  // and the copy the manage list keeps would drift from it silently.
  it('calls wasLastReviewARejection rather than restating the rule', () => {
    expect(
      serviceSource,
      'getPackDetail must derive the verdict with wasLastReviewARejection, not restate it.'
    ).toContain('wasLastReviewARejection(packMeta.history)');
    expect(
      serviceSource,
      "A restated rule is the regression this guards: the verdict's own literal must not appear here."
    ).not.toMatch(/(===?|!==?)\s*'reject'/);
  });

  // The whitelist is shared with the storefront sanitizers. Two lists over one
  // column is how a field ends up published on one path and not the other,
  // which is the shape this endpoint had.
  it('spreads the shared pack display whitelist', () => {
    expect(
      serviceSource,
      'The pack display fields must come from packDisplayMeta, not a second hand-written list.'
    ).toContain('...packDisplayMeta(packMeta)');
  });
});
