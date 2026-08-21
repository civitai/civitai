import type { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import type { QueueImage } from '~/server/utils/queue-image';
import { toQueueImage } from '~/server/utils/queue-image';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import type { StickerBookSettings } from '~/shared/utils/sticker-book';
import { getBlockedPairIds } from '~/server/services/user-preferences.service';
import { stickerBookAccess } from '~/shared/utils/sticker-book';

const SURFACE = 'sticker' as const;
const TARGET_TYPE = 'image' as const;

/**
 * A placement whose money actually moved to the owner.
 *
 * `toOwner` is the approval split; `feeToOwner` is the fee a decline leaves
 * behind. Both are Buzz the creator received for a sticker, which is the
 * question the total answers — and the decline fee is the one the creator is
 * least likely to be able to account for anywhere else.
 */
const OWNER_PAYOUT_KINDS = ['toOwner', 'feeToOwner'];

/** What one image looks like in either section. */
const IMAGE_SELECT = {
  id: true,
  url: true,
  name: true,
  width: true,
  height: true,
  type: true,
  metadata: true,
  nsfwLevel: true,
} as const;

/**
 * The publish rules a sticker book obeys.
 *
 * The same set `getMyStickerPlacements` applies to somebody else's image, and
 * applied here to the profile owner's own work as well. A sticker book is a
 * browse surface, not a queue: nobody has to act on a row, so an image that is
 * unpublished, unscanned or taken down is simply not in it — for its owner
 * either, rather than the owner seeing a book their visitors do not.
 */
const PUBLIC_IMAGE_FILTER = {
  post: { publishedAt: { not: null } },
  ingestion: 'Scanned',
  tosViolation: false,
  minor: false,
  poi: false,
} as const;

/**
 * How many placement rows a section may consider before it stops.
 *
 * The window is on the PLACEMENTS, and the images are filtered afterwards, so a
 * section can come back shorter than its limit. That is the honest shape: the
 * alternative is looping until the page is full, which on an account whose
 * images were all unpublished is an unbounded scan for an empty answer.
 */
const MAX_SECTION_LIMIT = 60;

type StickerBookImageRow = {
  id: number;
  url: string;
  name: string | null;
  width: number | null;
  height: number | null;
  type: MediaType;
  metadata: Prisma.JsonValue;
  nsfwLevel: number;
};

/**
 * Only the servable arm of `QueueImage`. A queue keeps the withheld variant so
 * the owner can still act on the row; a book has nothing to act on, so an image
 * this domain may not serve is simply not in the section — and the payload
 * cannot carry a url it was not allowed to send.
 */
export type StickerBookImage = Extract<QueueImage<StickerBookImageRow>, { viewable: true }>;

async function viewableImages({
  imageIds,
  domainLevels,
  viewerLevels,
}: {
  imageIds: number[];
  domainLevels: number;
  viewerLevels: number;
}) {
  if (!imageIds.length) return new Map<number, StickerBookImage>();

  const images = await dbRead.image.findMany({
    where: { id: { in: [...new Set(imageIds)] }, ...PUBLIC_IMAGE_FILTER },
    select: IMAGE_SELECT,
  });

  const result = new Map<number, StickerBookImage>();
  for (const image of images) {
    const queued = toQueueImage(image, domainLevels, viewerLevels);
    // Both halves matter and they are different rules. `viewable: false` is the
    // domain refusing to serve the asset at all; `withinViewerLevel` is the
    // viewer's own band, which a feed drops rather than blurs — and this is a
    // feed, not a queue somebody has to answer.
    if (queued?.viewable && queued.withinViewerLevel) result.set(image.id, queued);
  }

  return result;
}

/**
 * One section of the book: images carrying approved sticker placements, one card
 * per IMAGE.
 *
 * Grouped in the database rather than in JS over a window of rows. The card
 * carries a count ("2 stickers"), and a count derived from whatever fitted in
 * the window goes wrong exactly on the images that got the most attention — and
 * grouping is also what stops one image appearing five times because five people
 * stickered it, which is the repetition Ellie objected to in the session.
 *
 * Approved only, in both directions. A pending placement is a request the target
 * creator has not answered yet; it is visible to the two parties in the review
 * queue, and publishing it on a profile would show a placement to everyone
 * before the person being asked has said yes.
 *
 * `side` picks which end of the placement this creator is on — `placer` is
 * "images they stickered", `owner` is "their images that got stickered". One
 * function because they are the same query with one column swapped, and two
 * copies is how the pending rule ends up applied to only one of them.
 */
async function getPlacementSection({
  userId,
  side,
  limit,
  blockedIds,
  domainLevels,
  viewerLevels,
}: {
  userId: number;
  side: 'placer' | 'owner';
  limit: number;
  /**
   * Both directions of the viewer's blocks. A block is a PAIR, so this excludes
   * people the viewer blocked and people who blocked the viewer — and it is
   * applied to the OTHER end of each placement, which is the only end this
   * creator's book can put in front of them.
   *
   * Not the same thing as a hidden user: hides are a preference the feed applies
   * client-side and this page does not, which is stated rather than implied
   * because the two are one word apart and only one of them is a safety control.
   */
  blockedIds: number[];
  domainLevels: number;
  viewerLevels: number;
}) {
  const counterpartField = side === 'placer' ? 'ownerId' : 'placerId';
  const where = {
    surface: SURFACE,
    targetType: TARGET_TYPE,
    status: 'approved',
    ...(side === 'placer' ? { placerId: userId } : { ownerId: userId }),
    ...(blockedIds.length ? { [counterpartField]: { notIn: blockedIds } } : {}),
  };

  const groups = await dbRead.placement.groupBy({
    by: ['targetId'],
    where,
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } },
    take: limit,
  });

  if (!groups.length) return [];

  const targetIds = groups.map((group) => group.targetId);

  const [images, rows] = await Promise.all([
    viewableImages({ imageIds: targetIds, domainLevels, viewerLevels }),
    // The counterpart on each row — who owns the image on the placed side, who
    // placed on the received side — for the name under the card. Bounded by the
    // page, not by the creator's history.
    dbRead.placement.findMany({
      where: { ...where, targetId: { in: targetIds } },
      select: {
        targetId: true,
        createdAt: true,
        owner: { select: { id: true, username: true, deletedAt: true } },
        placer: { select: { id: true, username: true, deletedAt: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }),
  ]);

  return groups.flatMap((group) => {
    const image = images.get(group.targetId);
    if (!image) return [];

    const counterparts = rows.flatMap((row) => {
      if (row.targetId !== group.targetId) return [];
      const user = side === 'placer' ? row.owner : row.placer;
      // A deleted account keeps the placement — the image still wears the
      // sticker — but it is not somebody to name or link to.
      if (!user || user.deletedAt || !user.username) return [];
      return [{ id: user.id, username: user.username }];
    });

    return [
      {
        imageId: group.targetId,
        image,
        // The group's count, so it is the number of placements rather than the
        // number this page happened to be able to name.
        placementCount: group._count._all,
        latestAt: group._max.createdAt,
        // Newest first, de-duplicated: one person stickering an image three
        // times is one name.
        counterparts: counterparts.filter(
          (user, index) => counterparts.findIndex((other) => other.id === user.id) === index
        ),
      },
    ];
  });
}

/**
 * Buzz that reached this creator from stickers, taken from the LEDGER rather
 * than from `Placement.amount`.
 *
 * `amount` is what the placer paid in; the owner's share of it is an
 * operator-tunable split applied at settlement, and a decline pays a fee instead
 * of a share. Adding up what placers paid would state a number the creator never
 * received, on the page that exists to tell them what they earned.
 *
 * `transactionId IS NOT NULL` is the difference between a planned leg and a paid
 * one — the row is written before the ledger call and stamped after it.
 */
async function getEarnedBuzz(userId: number) {
  const [row] = await dbRead.$queryRaw<{ earned: number }[]>`
    SELECT COALESCE(SUM(pt."amount"), 0)::int AS "earned"
    FROM "PlacementTransaction" pt
    JOIN "Placement" p ON p.id = pt."placementId"
    WHERE p."ownerId" = ${userId}
      AND p."surface" = ${SURFACE}
      AND pt."kind" = ANY(${OWNER_PAYOUT_KINDS}::text[])
      AND pt."transactionId" IS NOT NULL
  `;

  return row?.earned ?? 0;
}

/**
 * The stickers a creator holds, newest acquisition first — the order the
 * placement tray uses, so the same collection reads the same way in both places.
 *
 * `remaining` is summed and `unlimited` decided the way `getStickerBalances`
 * does, because spending drains across holdings and a single NULL holding wins
 * outright. It is stripped before it leaves this module when the viewer is not
 * the owner.
 */
async function getStickerHoldings(userId: number) {
  return dbRead.$queryRaw<
    { cosmeticId: number; remaining: number | null; unlimited: boolean }[]
  >`
    SELECT
      uc."cosmeticId",
      SUM(uc."remaining")::int AS "remaining",
      bool_or(uc."remaining" IS NULL) AS "unlimited"
    FROM "UserCosmetic" uc
    JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
    WHERE uc."userId" = ${userId} AND c.type = 'Sticker'::"CosmeticType"
    GROUP BY uc."cosmeticId"
    ORDER BY MAX(uc."obtainedAt") DESC
  `;
}

/**
 * One creator's sticker book, shaped for whoever is looking at it.
 *
 * 🔴 EVERY PRIVATE FIELD IS DECIDED HERE, NOT IN THE COMPONENT. The two toggles,
 * the moderator override and the owner-only quantities all resolve on the server
 * and the withheld halves are never serialised — a client that forgets a check
 * cannot leak what it was never sent, and "the tab hides it" is not a control
 * when the payload is a fetch away.
 */
export async function getStickerBook({
  username,
  viewerId,
  isModerator = false,
  limit = 12,
  domainLevels,
  viewerLevels,
}: {
  username: string;
  viewerId?: number;
  isModerator?: boolean;
  limit?: number;
  domainLevels: number;
  viewerLevels: number;
}) {
  const user = await dbRead.user.findFirst({
    where: { username },
    select: { id: true, username: true, settings: true, bannedAt: true, deletedAt: true },
  });

  if (!user || user.deletedAt) throw throwNotFoundError('User not found');

  const isOwner = !!viewerId && viewerId === user.id;
  const access = stickerBookAccess(user.settings as StickerBookSettings | null, {
    isOwner,
    isModerator,
  });

  // A banned account's book is closed to visitors for the same reason its other
  // tabs are, and open to moderators for the same reason theirs are.
  const banned = !!user.bannedAt && !isOwner && !isModerator;

  if (banned || !access.canViewBook) {
    return {
      userId: user.id,
      isOwner,
      access: { ...access, canViewBook: false, canViewStickers: false, canViewEarnings: false },
      stickers: [],
      placed: [],
      received: [],
      earnedBuzz: null,
    };
  }

  const sectionLimit = Math.min(Math.max(limit, 1), MAX_SECTION_LIMIT);
  const blockedIds = viewerId ? await getBlockedPairIds(viewerId) : [];

  const [holdings, placed, received, earnedBuzz] = await Promise.all([
    access.canViewStickers ? getStickerHoldings(user.id) : Promise.resolve([]),
    getPlacementSection({
      userId: user.id,
      side: 'placer',
      limit: sectionLimit,
      blockedIds,
      domainLevels,
      viewerLevels,
    }),
    getPlacementSection({
      userId: user.id,
      side: 'owner',
      limit: sectionLimit,
      blockedIds,
      domainLevels,
      viewerLevels,
    }),
    access.canViewEarnings ? getEarnedBuzz(user.id) : Promise.resolve(null),
  ]);

  return {
    userId: user.id,
    isOwner,
    access,
    stickers: holdings.map(({ cosmeticId, remaining, unlimited }) => ({
      cosmeticId,
      // Absent, not zero and not null, for anyone but the owner: `null` already
      // means unlimited here, so a visitor must not be handed the field at all.
      ...(access.canViewQuantities ? { remaining: unlimited ? null : remaining ?? 0 } : {}),
    })),
    placed,
    received,
    earnedBuzz,
  };
}
