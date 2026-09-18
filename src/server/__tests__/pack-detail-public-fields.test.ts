import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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

// The canonical client mock, per docs/testing/shared-module-mocks.md. It keeps
// `dbRead` and `dbWrite` distinct, which matters here: the ownership read is on
// the WRITER deliberately, and the discount test below is what makes that
// choice observable — declared against the reader it answers `[]` by default
// and the quote loses its discount.
const shopItemFindUnique = dbMock.dbRead.cosmeticShopItem.findUnique;
const shopItemFindMany = dbMock.dbRead.cosmeticShopItem.findMany;
const ownedFindMany = dbMock.dbWrite.userCosmetic.findMany;

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

// A pack whose last REVIEW rejected, with a later non-review entry after it so
// the helper cannot pass by reading the last entry. The status is a parameter
// because an unauthorized caller never reaches the return on a non-Published
// pack — the gate above throws first — so the gating test needs a Published one
// to have anything to assert about.
const rejectedPack = (status = CosmeticShopItemStatus.Archived) => ({
  id: PACK_ID,
  cosmeticId: null,
  title: 'A pack',
  description: null,
  unitAmount: 8800,
  status,
  listed: false,
  availableQuantity: null,
  meta: {
    ...META,
    history: [
      { at: 'then', userId: MODERATOR_ID, kind: 'reviewed', action: 'approve' },
      {
        at: 'later',
        userId: MODERATOR_ID,
        kind: 'reviewed',
        action: 'reject',
        note: 'note-sentinel-70018',
      },
      { at: 'later still', userId: LISTER, kind: 'edited' },
    ],
  },
  addedById: LISTER,
  members: [{ cosmeticId: MEMBER, floorAmount: 2600 }],
  _count: { purchases: 0 },
});

// The canonical mock resets once per FILE, not per test, so these three
// `mockResolvedValue` calls are what isolate the cases — they replace the
// implementation, and a per-test override cannot leak forward. Call COUNTS do
// accumulate across the file; nothing here asserts one, and the first test that
// does has to clear them itself.
beforeEach(() => {
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
    // Deliberately unequal to `META.purchases`: the sold count comes from the
    // purchase rows, and a fixture where the two agree cannot show which one
    // the response carried.
    _count: { purchases: 9 },
  });
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
    //
    // `lastReviewWasRejection` is expected PRESENT with an undefined value for a
    // caller who is not answered — `JSON.stringify` drops it, so it never
    // reaches the wire. If you change the service to omit the key instead, that
    // is an improvement and this listing is what you edit.
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

  it('discounts the quote by what this viewer already owns', async () => {
    // The ownership read is on the WRITER, deliberately — a replica that has not
    // caught up quotes a price above what the purchase charges. This is the
    // assertion that makes that choice observable: pointed at the reader, the
    // mock answers `[]` and the discount vanishes.
    ownedFindMany.mockResolvedValue([{ cosmeticId: MEMBER }]);
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: VISITOR });
    expect(detail.discount).toBeGreaterThan(0);
    expect(detail.amountDue).toBeLessThan(8800);
    expect(detail.members[0].owned).toBe(true);
  });

  it('returns only the member fields the contents panel renders', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID });
    // The value fence below catches a whole listing passed through; this catches
    // one named field lifted onto a member, whose value no sentinel knows.
    expect(Object.keys(detail.members[0]).sort()).toEqual([
      'acceptsBlueBuzz',
      'consumable',
      'cosmeticId',
      'creatorUsername',
      'currentListPrice',
      'data',
      'discount',
      'isOwn',
      'listPrice',
      'name',
      'owned',
      'type',
      'uses',
    ]);
  });

  it('still carries what the pack page renders', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID });
    expect(detail.meta).toEqual({
      coverUrl: 'cover.png',
      coverTiles: ['a.png'],
      packMemberCount: 1,
      acceptsBlueBuzz: true,
      // The row count, not `META.purchases`, which this fixture sets to 3.
      purchases: 9,
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
    // A REJECTING fixture, so each authorized arm expects `true`. With an
    // approving one every arm expects `false`, and a service that hardcodes
    // `false` satisfies the whole test — which is how this pairs with the
    // rejection test below. Neither is redundant; deleting either disarms the
    // other.
    shopItemFindUnique.mockResolvedValue(rejectedPack(CosmeticShopItemStatus.Published));
    expect(
      (await getPackDetail({ shopItemId: PACK_ID })).lastReviewWasRejection,
      'an anonymous caller gets no answer, not a false one'
    ).toBeUndefined();
    expect(
      (await getPackDetail({ shopItemId: PACK_ID, userId: VISITOR })).lastReviewWasRejection
    ).toBeUndefined();
    expect(
      (await getPackDetail({ shopItemId: PACK_ID, userId: LISTER })).lastReviewWasRejection
    ).toBe(true);
    expect(
      (await getPackDetail({ shopItemId: PACK_ID, userId: MODERATOR_ID, isModerator: true }))
        .lastReviewWasRejection
    ).toBe(true);
    // A moderator context with no userId: without this arm the gate could be
    // rewritten as `!!userId && (...)` and every other arm still passes.
    expect(
      (await getPackDetail({ shopItemId: PACK_ID, isModerator: true })).lastReviewWasRejection
    ).toBe(true);
  });

  it('reports no rejection to the lister when the last verdict approved', async () => {
    expect(
      (await getPackDetail({ shopItemId: PACK_ID, userId: LISTER })).lastReviewWasRejection
    ).toBe(false);
  });

  it('refuses a pack that is not on sale to anyone but the lister and moderators', async () => {
    // The same predicate decides this and the verdict, and this pins the
    // BEHAVIOUR of both uses — re-splitting the const into two identical
    // spellings would still pass, so read it as coverage, not as a guarantee
    // that the rule stays shared.
    //
    // The two accepting arms are not decoration: `/pack not found/i` is also the
    // message when the item is missing entirely, so without them a mis-armed
    // fixture would satisfy the refusals for the wrong reason.
    shopItemFindUnique.mockResolvedValue(rejectedPack());
    await expect(getPackDetail({ shopItemId: PACK_ID })).rejects.toThrow(/pack not found/i);
    await expect(getPackDetail({ shopItemId: PACK_ID, userId: VISITOR })).rejects.toThrow(
      /pack not found/i
    );
    expect((await getPackDetail({ shopItemId: PACK_ID, userId: LISTER })).id).toBe(PACK_ID);
    expect((await getPackDetail({ shopItemId: PACK_ID, isModerator: true })).id).toBe(PACK_ID);
  });

  it('reads the last verdict rather than the last entry', async () => {
    shopItemFindUnique.mockResolvedValue(rejectedPack());
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: LISTER });
    expect(detail.lastReviewWasRejection).toBe(true);
    // The fixture's last entry is an edit, not a review, and its rejecting entry
    // carries a note that must not travel with the verdict.
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
  // column is how a field ends up published on one path and not the other.
  it('spreads the shared pack display whitelist', () => {
    expect(
      serviceSource,
      'The pack display fields must come from packDisplayMeta, not a second hand-written list.'
    ).toContain('...packDisplayMeta(packMeta)');
  });
});
