import { dbRead } from '~/server/db/client';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';
import { getAllImages } from '~/server/services/image.service';
import { throwNotFoundError } from '~/server/utils/errorHandling';
import type { SessionUser } from '~/types/session';
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

  // The counterpart on each row — who owns the image on the placed side, who
  // placed on the received side — for the avatar under the card. Bounded by the
  // page, not by the creator's history.
  const rows = await dbRead.placement.findMany({
    where: { ...where, targetId: { in: targetIds } },
    select: {
      targetId: true,
      createdAt: true,
      owner: { select: { id: true, username: true, deletedAt: true, image: true } },
      placer: { select: { id: true, username: true, deletedAt: true, image: true } },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    // Deliberately NOT capped with a `take`. The rows are ordered newest-first
    // across the whole page, so a cap is spent in that order too — one image
    // carrying a burst of recent placements would eat the budget and leave the
    // other cards on the page with nobody named under them.
  });

  // Bucketed once rather than rescanned per group: filtering `rows` inside the
  // loop below is |page| x |rows|.
  const byTarget = new Map<number, typeof rows>();
  for (const row of rows) {
    const bucket = byTarget.get(row.targetId);
    if (bucket) bucket.push(row);
    else byTarget.set(row.targetId, [row]);
  }

  const items = page.flatMap((group) => {
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
      return [{ id: user.id, username: user.username, image: user.image }];
    });

    return [
      {
        imageId: group.targetId,
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
 * The book's images, in the feed's own shape, so the page can draw them with the
 * standard image card.
 *
 * 🔴 THROUGH `getAllImages`, NOT A READ OF OUR OWN. Every rule about whether an
 * image may be shown lives in there — the browsing level, the domain ceiling,
 * the publish and moderation state, the blocked-browsing-tag policy — and a
 * hand-written `image.findMany` beside it is a second copy that drifts. The
 * sticker book decides WHICH images and in what order; it does not get to decide
 * what may be seen.
 *
 * Called as a function rather than through the feed endpoint: the dispatcher in
 * `image.controller` may route a feed query to the search index, which has no
 * `ids` filter and drops it silently — an `ids` query served that way comes back
 * with the global feed rather than empty.
 */
async function imagesForBook({
  ids,
  browsingLevel,
  user,
}: {
  ids: number[];
  browsingLevel: number;
  user?: SessionUser;
}) {
  if (!ids.length) return [];

  const input = getInfiniteImagesSchema.parse({
    ids,
    browsingLevel,
    period: 'AllTime',
    sort: 'Newest',
    limit: ids.length,
    include: [],
  });

  const { items } = await getAllImages({ ...input, user, userId: user?.id });
  const byId = new Map(items.map((image) => [image.id, image]));

  // The book's order, not the feed's. An image the feed withheld is simply
  // absent, which is the same answer as it not being in the book.
  return ids.flatMap((id) => {
    const image = byId.get(id);
    return image ? [image] : [];
  });
}

/**
 * The section's rows with their image attached, and rows whose image the feed
 * withheld dropped.
 *
 * Dropped rather than sent without a picture: a book is a browse surface and
 * nobody has to act on a row here, unlike the review queues, which keep a
 * withheld row so its escrow can still be answered.
 */
async function withImages<T extends { imageId: number }>(
  rows: T[],
  browsingLevel: number,
  user?: SessionUser
) {
  const images = await imagesForBook({
    ids: rows.map((row) => row.imageId),
    browsingLevel,
    user,
  });
  const byId = new Map(images.map((image) => [image.id, image]));

  return rows.flatMap((row) => {
    const image = byId.get(row.imageId);
    return image ? [{ ...row, image }] : [];
  });
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
  const subject = await dbRead.user.findFirst({
    where: { username },
    select: { id: true, username: true, settings: true, bannedAt: true, deletedAt: true },
  });

  if (!subject || subject.deletedAt) throw throwNotFoundError('User not found');

  const isOwner = !!viewerId && viewerId === subject.id;
  const access = stickerBookAccess(subject.settings as StickerBookSettings | null, {
    isOwner,
    isModerator,
  });

  // A banned account's book is closed to visitors for the same reason its other
  // tabs are, and open to moderators for the same reason theirs are.
  const banned = !!subject.bannedAt && !isOwner && !isModerator;

  return {
    subject,
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
  browsingLevel,
  user,
  isModerator = false,
}: {
  username: string;
  side: 'placer' | 'owner';
  page?: number;
  limit?: number;
  browsingLevel: number;
  user?: SessionUser;
  isModerator?: boolean;
}) {
  const viewerId = user?.id;
  const { subject, isOwner, access } = await resolveBookAccess({ username, viewerId, isModerator });

  // The gate is re-asked here rather than assumed from the tab having rendered.
  // A procedure is a URL, and a hidden book must refuse this one on its own.
  if (!access.canViewBook) return { items: [], hasMore: false, isOwner, access };

  const sectionLimit = Math.min(Math.max(limit, 1), MAX_SECTION_LIMIT);
  const blockedIds = viewerId ? await getBlockedPairIds(viewerId) : [];

  const { items, hasMore } = await getPlacementSection({
    userId: subject.id,
    side,
    limit: sectionLimit,
    skip: Math.max(page - 1, 0) * sectionLimit,
    blockedIds,
  });

  return { items: await withImages(items, browsingLevel, user), hasMore, isOwner, access };
}

export async function getStickerBook({
  username,
  browsingLevel,
  user,
  isModerator = false,
  limit = 12,
}: {
  username: string;
  browsingLevel: number;
  user?: SessionUser;
  isModerator?: boolean;
  limit?: number;
}) {
  const viewerId = user?.id;
  const { subject, isOwner, access } = await resolveBookAccess({ username, viewerId, isModerator });

  if (!access.canViewBook) {
    return {
      userId: subject.id,
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
      ? getStickerBalances(subject.id, { newestFirst: true })
      : Promise.resolve([]),
    getPlacementSection({
      userId: subject.id,
      side: 'placer',
      limit: sectionLimit,
      blockedIds,
    }),
    getPlacementSection({
      userId: subject.id,
      side: 'owner',
      limit: sectionLimit,
      blockedIds,
    }),
    access.canViewEarnings ? getEarnedBuzz(subject.id) : Promise.resolve(null),
  ]);

  return {
    userId: subject.id,
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
    placed: await withImages(placed.items, browsingLevel, user),
    received: await withImages(received.items, browsingLevel, user),
    earnedBuzz,
  };
}
