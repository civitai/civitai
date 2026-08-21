import type { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import {
  placementImageSelect,
  publishedPlacementImageWhere,
} from '~/server/selectors/placement-image.selector';
import type { QueueImage } from '~/server/utils/queue-image';
import { toQueueImage } from '~/server/utils/queue-image';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import type { StickerBookSettings } from '~/shared/utils/sticker-book';
import { getStickerBalances } from '~/server/services/sticker.service';
import { getBlockedPairIds } from '~/server/services/user-preferences.service';
import { PLACEMENT_OWNER_PAYOUT_KINDS } from '~/shared/utils/placement';
import { stickerBookAccess } from '~/shared/utils/sticker-book';

const SURFACE = 'sticker' as const;
const TARGET_TYPE = 'image' as const;

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
    where: { id: { in: [...new Set(imageIds)] }, ...publishedPlacementImageWhere() },
    select: placementImageSelect,
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
 * Grouped in the database rather than in JS over a window of rows: it is what
 * stops one image appearing five times because five people stickered it, which
 * is the repetition Ellie objected to in the session.
 *
 * No count comes back with it. The card's count chip reads the shared placement
 * batch — which is also the reveal control — and a second count computed here
 * would be filtered differently from the stickers actually drawn, so the badge
 * could say 3 over an image wearing 4.
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
  skip = 0,
  blockedIds,
  domainLevels,
  viewerLevels,
}: {
  userId: number;
  side: 'placer' | 'owner';
  limit: number;
  /**
   * Offset paging, on the GROUPS. A cursor would be better and is not available:
   * the order is `max(createdAt)` per image, which is not a column and cannot be
   * compared against a keyset. The cost is that a placement landing mid-walk can
   * shift a row across a page boundary — visible as a repeat on a browse feed,
   * which is what this is.
   */
  skip?: number;
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
  const blocked = blockedIds.length ? { notIn: blockedIds } : undefined;
  // Written out per side rather than with a computed key. A computed key that
  // named the wrong end would OVERWRITE the id that scopes the query to this
  // creator — silently, still returning rows, just somebody else's.
  const where =
    side === 'placer'
      ? {
          surface: SURFACE,
          targetType: TARGET_TYPE,
          status: 'approved',
          placerId: userId,
          ownerId: blocked,
        }
      : {
          surface: SURFACE,
          targetType: TARGET_TYPE,
          status: 'approved',
          ownerId: userId,
          placerId: blocked,
        };

  const groups = await dbRead.placement.groupBy({
    by: ['targetId'],
    where,
    _max: { createdAt: true },
    orderBy: { _max: { createdAt: 'desc' } },
    take: limit + 1,
    skip,
  });

  if (!groups.length) return { items: [], hasMore: false };

  // Read off the row past the page, BEFORE the image filter drops anything. A
  // page that came back short because its images were unpublished still has a
  // next page, and deciding from what survived would end the walk early.
  const hasMore = groups.length > limit;
  const page = groups.slice(0, limit);

  const targetIds = page.map((group) => group.targetId);

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
      // Deliberately NOT capped with a `take`. The rows are ordered newest-first
      // across the whole page, so a cap is spent in that order too — one image
      // carrying a burst of recent placements would eat the budget and leave the
      // other cards on the page with no name under them at all. A missing
      // caption on an arbitrary card is a worse outcome than reading rows we
      // discard, and the bucketing below is what made the discarding cheap.
    }),
  ]);

  // Bucketed once rather than rescanned per group: filtering `rows` inside the
  // loop below is |page| x |rows|.
  const byTarget = new Map<number, typeof rows>();
  for (const row of rows) {
    const bucket = byTarget.get(row.targetId);
    if (bucket) bucket.push(row);
    else byTarget.set(row.targetId, [row]);
  }

  const items = page.flatMap((group) => {
    const image = images.get(group.targetId);
    if (!image) return [];

    // Newest first from the query, de-duplicated by a Set: one person stickering
    // an image three times is one name, and `findIndex` inside a filter is
    // quadratic in a number the placer controls.
    const seen = new Set<number>();
    const counterparts = (byTarget.get(group.targetId) ?? []).flatMap((row) => {
      const user = side === 'placer' ? row.owner : row.placer;
      // A deleted account keeps the placement — the image still wears the
      // sticker — but it is not somebody to name or link to.
      if (!user || user.deletedAt || !user.username || seen.has(user.id)) return [];
      seen.add(user.id);
      return [{ id: user.id, username: user.username }];
    });

    return [
      {
        imageId: group.targetId,
        image,
        latestAt: group._max.createdAt,
        counterparts,
      },
    ];
  });

  return { items, hasMore };
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
      AND pt."kind" = ANY(${[...PLACEMENT_OWNER_PAYOUT_KINDS]}::text[])
      AND pt."transactionId" IS NOT NULL
  `;

  return row?.earned ?? 0;
}

/**
 * Whose book this is, and what this viewer may have of it.
 *
 * 🔴 SHARED BY EVERY ENTRY POINT, AND THAT IS THE POINT. The tab and the
 * drill-in page are two procedures reading the same private content; a second
 * copy of this decision is how one of them ends up without the banned check or
 * without a toggle. Anything new that reads a book calls this first.
 */
async function resolveBookAccess({
  username,
  viewerId,
  isModerator,
}: {
  username: string;
  viewerId?: number;
  isModerator: boolean;
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

  return {
    user,
    isOwner,
    access:
      banned || !access.canViewBook
        ? { ...access, canViewBook: false, canViewStickers: false, canViewEarnings: false }
        : access,
  };
}

/**
 * One page of a single section, for the "View all" behind each row.
 *
 * The same query the tab runs, with an offset — deliberately not a second query
 * shaped for a bigger page. What differs between the row and the page is how
 * many, and nothing else.
 */
export async function getStickerBookSection({
  username,
  side,
  page = 1,
  limit = 30,
  viewerId,
  isModerator = false,
  domainLevels,
  viewerLevels,
}: {
  username: string;
  side: 'placer' | 'owner';
  page?: number;
  limit?: number;
  viewerId?: number;
  isModerator?: boolean;
  domainLevels: number;
  viewerLevels: number;
}) {
  const { user, isOwner, access } = await resolveBookAccess({ username, viewerId, isModerator });

  // The gate is re-asked here rather than assumed from the tab having rendered.
  // A procedure is a URL, and a hidden book must refuse this one on its own.
  if (!access.canViewBook) return { items: [], hasMore: false, isOwner, access };

  const sectionLimit = Math.min(Math.max(limit, 1), MAX_SECTION_LIMIT);
  const blockedIds = viewerId ? await getBlockedPairIds(viewerId) : [];

  const { items, hasMore } = await getPlacementSection({
    userId: user.id,
    side,
    limit: sectionLimit,
    skip: Math.max(page - 1, 0) * sectionLimit,
    blockedIds,
    domainLevels,
    viewerLevels,
  });

  return { items, hasMore, isOwner, access };
}

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
  const { user, isOwner, access } = await resolveBookAccess({ username, viewerId, isModerator });

  if (!access.canViewBook) {
    return {
      userId: user.id,
      isOwner,
      access,
      stickers: [],
      placed: [],
      received: [],
      earnedBuzz: null,
    };
  }

  const sectionLimit = Math.min(Math.max(limit, 1), MAX_SECTION_LIMIT);
  const blockedIds = viewerId ? await getBlockedPairIds(viewerId) : [];

  const [holdings, placed, received, earnedBuzz] = await Promise.all([
    // Newest acquisition first — the order the placement tray presents the same
    // collection in.
    access.canViewStickers
      ? getStickerBalances(user.id, { newestFirst: true })
      : Promise.resolve([]),
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
    stickers: holdings.map(({ cosmeticId, remaining }) => ({
      cosmeticId,
      // Absent, not zero and not null, for anyone but the owner: `null` already
      // means unlimited here, so a visitor must not be handed the field at all.
      ...(access.canViewQuantities ? { remaining } : {}),
    })),
    // The row's items only. `hasMore` belongs to the drill-in page, which asks
    // for its own pages; on the tab the "View all" link is there either way.
    placed: placed.items,
    received: received.items,
    earnedBuzz,
  };
}
