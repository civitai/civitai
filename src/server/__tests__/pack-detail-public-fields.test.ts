import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';

/**
 * `creatorShop.getPack` is a `publicProcedure`, so whatever `getPackDetail`
 * returns is readable by anyone holding a pack id.
 *
 * The decision this pins: the endpoint NAMES the meta fields a pack page
 * renders instead of returning the column. `CosmeticShopItemMeta` is one JSON
 * blob shared with the review and payout bookkeeping, so returning it whole
 * couples a public read to every future field anyone adds to it — which is the
 * part a field-level pick fixes and a one-off deletion does not.
 *
 * If you are widening this back to `meta: item.meta`, the guard in
 * `src/components/CreatorShop/Pack/__tests__/moderator-pack-edit-route.test.ts`
 * is the other half: the editor's rejected-vs-archived split was moved onto
 * `lastReviewWasRejection` for this reason, not because the helper was wrong.
 */

const shopItemFindUnique = vi.fn();
const shopItemFindMany = vi.fn();
const packMemberFindMany = vi.fn();
const ownedFindMany = vi.fn();

vi.mock('~/server/db/client', () => ({
  dbRead: {
    cosmeticShopItem: {
      findUnique: (...a: unknown[]) => shopItemFindUnique(...a),
      findMany: (...a: unknown[]) => shopItemFindMany(...a),
    },
    cosmeticShopItemCosmetic: { findMany: (...a: unknown[]) => packMemberFindMany(...a) },
    userCosmeticShopPurchaseCosmetic: { groupBy: vi.fn().mockResolvedValue([]) },
    userCosmetic: { findMany: (...a: unknown[]) => ownedFindMany(...a) },
    userCosmeticShopItemResale: { findMany: vi.fn().mockResolvedValue([]) },
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
const MODERATOR_ID = 999;

const cosmetic = {
  id: MEMBER,
  name: 'Badge',
  type: CosmeticType.Badge,
  data: { url: 'img' },
  createdById: LISTER,
  creator: { username: 'lister' },
};

// A real pack's meta: the four fields the pack page reads, sitting in the same
// blob as review and payout bookkeeping.
const META = {
  purchases: 3,
  coverUrl: 'cover.png',
  coverTiles: ['a.png'],
  acceptsBlueBuzz: true,
  creatorId: LISTER,
  submissionTxId: 'tx-123',
  submissionFee: 500,
  lastApprovedAmount: 8800,
  paidToUserIds: [LISTER],
  imageHash: 'deadbeef',
  rightsAffirmation: { userId: LISTER, affirmedAt: 'then', version: 1, statement: 'I own it' },
  takedown: { reason: 'IP claim from a rightsholder', moderatorId: MODERATOR_ID, at: 'then' },
  history: [
    {
      at: 'then',
      userId: MODERATOR_ID,
      kind: 'reviewed',
      status: CosmeticShopItemStatus.Published,
      action: 'approve',
      note: 'fine, but watch this creator',
    },
  ],
};

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
      meta: { purchases: 0 },
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

describe('public pack detail returns named meta fields, not the meta column', () => {
  it('returns only the meta fields the pack page renders', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID });
    // The listing, not a subset check: a new key appearing here is a new field
    // going public, and this test is the place that decision gets made.
    expect(Object.keys(detail.meta).sort()).toEqual([
      'acceptsBlueBuzz',
      'coverTiles',
      'coverUrl',
      'purchases',
    ]);
  });

  it('still carries what the pack page renders', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID });
    expect(detail.meta).toEqual({
      coverUrl: 'cover.png',
      coverTiles: ['a.png'],
      acceptsBlueBuzz: true,
      purchases: 3,
    });
  });

  it('holds back review and payout bookkeeping from every caller, moderators included', async () => {
    for (const caller of [
      { shopItemId: PACK_ID },
      { shopItemId: PACK_ID, userId: VISITOR },
      { shopItemId: PACK_ID, userId: LISTER },
      { shopItemId: PACK_ID, userId: MODERATOR_ID, isModerator: true },
    ]) {
      const detail = await getPackDetail(caller);
      // Serialized, because the leak is whatever reaches the wire — a nested
      // copy under some other key is the same disclosure as a top-level one.
      const wire = JSON.stringify(detail);
      for (const secret of [
        'watch this creator',
        'IP claim from a rightsholder',
        String(MODERATOR_ID),
        'tx-123',
        'deadbeef',
        'I own it',
      ])
        expect(wire, `\`${secret}\` must not reach a pack detail response`).not.toContain(secret);
    }
  });

  it('answers the rejected-vs-archived question with a boolean instead of the history', async () => {
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
          { at: 'later', userId: MODERATOR_ID, kind: 'reviewed', action: 'reject', note: 'no' },
        ],
      },
      addedById: LISTER,
      members: [{ cosmeticId: MEMBER, floorAmount: 2600 }],
    });
    const rejected = await getPackDetail({ shopItemId: PACK_ID, userId: LISTER });
    expect(rejected.lastReviewWasRejection).toBe(true);
  });

  it('reports no rejection when the last verdict approved', async () => {
    const detail = await getPackDetail({ shopItemId: PACK_ID, userId: LISTER });
    expect(detail.lastReviewWasRejection).toBe(false);
  });
});

describe('the rejection verdict is derived once, on the server', () => {
  const serviceSource = readFileSync(
    path.join(process.cwd(), 'src/server/services/creator-shop-pack.service.ts'),
    'utf-8'
  );

  // The rule itself — last `reviewed` entry, `action === 'reject'` — is the part
  // that used to live in the client. Moving it here is only a move while it
  // still goes through the one helper; restated inline it is a second copy in a
  // new place, and the copy the manage list keeps would drift from it silently.
  it('calls wasLastReviewARejection rather than restating the rule', () => {
    expect(
      serviceSource,
      'getPackDetail must derive the verdict with wasLastReviewARejection, not restate it.'
    ).toContain('wasLastReviewARejection(packMeta.history)');
    expect(
      serviceSource,
      "A restated rule is the regression this guards: the verdict's own literal must not appear here."
    ).not.toContain("=== 'reject'");
  });
});
