import type { Prisma } from '@prisma/client';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  AnnouncementMetaSchema,
  UpsertCreatorAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import { CREATOR_ANNOUNCEMENT_CONTENT_MAX } from '~/server/schema/announcement.schema';
import { getAnnouncementAllowance } from '~/server/services/announcement-allowance.service';
import { resolveCoverImageId } from '~/server/services/cover-image.service';
import { isImageOwner } from '~/server/services/util.service';
import { amIBlockedByUser } from '~/server/services/user.service';
import { getAllServerHosts } from '~/server/utils/server-domain';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { DomainColor, UserEngagementType } from '~/shared/utils/prisma/enums';

// Two-arg classed form, as free-placement uses: the one-arg form shares an int4 keyspace
// with `article.service.ts`, which locks on a bare articleId, so a hashed key could collide
// with an unrelated article's lock.
const ANNOUNCEMENT_LOCK_CLASS = 0x414e0001;

const creatorAnnouncementSelect = {
  id: true,
  title: true,
  content: true,
  emoji: true,
  color: true,
  domain: true,
  startsAt: true,
  endsAt: true,
  disabled: true,
  profileOnly: true,
  coverId: true,
  createdAt: true,
  metadata: true,
  userId: true,
  cover: {
    select: {
      id: true,
      url: true,
      nsfwLevel: true,
      width: true,
      height: true,
      type: true,
      name: true,
      // MediaHash renders this while a cover is blurred; without it a blurred cover is an
      // empty box rather than a placeholder.
      hash: true,
    },
  },
  user: { select: { id: true, username: true, image: true } },
  // `satisfies`, not `as const`: a standalone object literal gets no excess-property
  // check when it is passed to Prisma later, so a column that does not exist typechecks
  // clean and 500s at runtime on every read and write. This is the check that catches it.
} satisfies Prisma.AnnouncementSelect;

type RawCreatorAnnouncement = {
  metadata: unknown;
  cover: { nsfwLevel: number } | null;
};

/**
 * `Announcement` has no nsfwLevel of its own, so the cover's level IS the announcement's —
 * text carries no rating here. Surfaced as a top-level field anyway so callers gate on one
 * number and cannot forget the cover, which is the only thing that can be mature.
 */
function toCreatorAnnouncementDTO<T extends RawCreatorAnnouncement>(announcement: T) {
  return {
    ...announcement,
    // Parsed here, as the sitewide DTO does, so the client reads metadata.actions
    // without a cast rather than being trusted to know the shape.
    metadata: (announcement.metadata ?? {}) as AnnouncementMetaSchema,
    nsfwLevel: announcement.cover?.nsfwLevel ?? 0,
  };
}

/**
 * Creator-authored announcements only. Every query here pins `userId` to a real author, so
 * a platform row (`userId: null`) can never be read, edited or deleted through this path —
 * the mirror of the sitewide caches, which select on null.
 */
export async function getCreatorAnnouncements({
  userId,
  limit = 10,
  includeHidden = false,
  domain,
  viewerId,
}: {
  userId: number;
  limit?: number;
  includeHidden?: boolean;
  domain?: DomainColor;
  viewerId?: number;
}) {
  const now = new Date();

  // After the migration this text IS the profile banner, and the banner is already
  // withheld from a blocked viewer (`user-profile.controller.ts`). A public read on an
  // arbitrary userId would otherwise hand it back.
  if (
    viewerId &&
    viewerId !== userId &&
    (await amIBlockedByUser({ userId: viewerId, targetUserId: userId }))
  )
    return [];

  const announcements = await dbRead.announcement.findMany({
    where: {
      userId,
      // The migrated SFW banners exist precisely so a green visitor does not see the
      // other one. Without this the profile shows both, which is a browsing-boundary
      // leak rather than a double-render.
      ...(domain ? { domain: { hasSome: [DomainColor.all, domain] } } : {}),
      ...(includeHidden
        ? {}
        : {
            disabled: false,
            OR: [{ startsAt: null }, { startsAt: { lte: now } }],
            AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
          }),
    },
    select: creatorAnnouncementSelect,
    orderBy: [{ startsAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: limit,
  });

  return announcements.map(toCreatorAnnouncementDTO);
}

/**
 * The *Creators* chip: live announcements from authors the caller follows.
 *
 * Muted creators are absent entirely, not merely demoted — leaving their posts in the feed
 * would not be the escape hatch the ticket asked for.
 *
 * Profile-only rows never appear here; that is what profile-only means.
 */
export async function getFollowedAnnouncements({
  userId,
  limit = 20,
  cursor,
  domain,
}: {
  userId: number;
  limit?: number;
  cursor?: number;
  domain?: DomainColor;
}) {
  const now = new Date();

  const announcements = await dbRead.announcement.findMany({
    where: {
      profileOnly: false,
      disabled: false,
      userId: { not: null },
      user: {
        // engagedUsers = rows where this author is the TARGET, i.e. their followers.
        // engagingUsers is the other direction (follows the author made) and would
        // return a plausible, wrong feed.
        announcementMutesReceived: { none: { userId } },
        // Blocks both ways, mirroring `notBlockedBetween` exactly — the asymmetry is
        // deliberate there: the viewer's Block OR Hide of the author hides it, while the
        // author's side hides it only on Block. A follow predates the block that
        // followed it, so the follow edge alone is not consent to keep appearing.
        engagingUsers: { none: { targetUserId: userId, type: UserEngagementType.Block } },
        // Both conditions are on engagedUsers, so they go in AND rather than as two keys
        // of the same object. A repeated key here is TS1117 and would not compile; the
        // hazard is the sibling `where`, where a spread between two keys makes the same
        // mistake legal and silent.
        AND: [
          { engagedUsers: { some: { userId, type: UserEngagementType.Follow } } },
          {
            engagedUsers: {
              none: {
                userId,
                type: { in: [UserEngagementType.Block, UserEngagementType.Hide] },
              },
            },
          },
        ],
      },
      ...(domain ? { domain: { hasSome: [DomainColor.all, domain] } } : {}),
      OR: [{ startsAt: null }, { startsAt: { lte: now } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
    },
    select: creatorAnnouncementSelect,
    orderBy: [{ startsAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const items = announcements.slice(0, limit).map(toCreatorAnnouncementDTO);

  return {
    items,
    nextCursor: announcements.length > limit ? items[items.length - 1]?.id : undefined,
  };
}

/**
 * `isModerator` widens this to any *authored* announcement — never to a platform row, which
 * has its own moderator tooling. Matches what moderators can already do to the profile
 * message this feature replaces: remove it in place, from wherever it is shown.
 */
async function assertOwnedAnnouncement(id: number, userId: number, isModerator = false) {
  const existing = await dbRead.announcement.findFirst({
    where: isModerator ? { id, userId: { not: null } } : { id, userId },
    select: { id: true, coverId: true, profileOnly: true, startsAt: true, content: true },
  });
  if (!existing) throw throwAuthorizationError('Announcement not found');
  return existing;
}

/**
 * A link to one of our own domains becomes a path, so the button resolves on whichever
 * domain the reader is on — a creator pasting a civitai.com URL should not send every
 * civitai.red reader across to the other site.
 *
 * Server-side rather than in the zod schema on purpose: the host list comes from
 * `getAllServerHosts`, which reads server env, and the announcement schema is imported by
 * client components.
 *
 * Anything not ours is left exactly as typed.
 */
export function toDomainRelativeLink(link: string) {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return link; // already a path; the schema has checked its shape
  }

  const host = url.host.toLowerCase();
  const ours = getAllServerHosts().some((h) => h.toLowerCase() === host);
  if (!ours) return link;

  return `${url.pathname}${url.search}${url.hash}` || '/';
}

/**
 * Enforces the content limit on new writing without trapping the rows that predate it.
 *
 * A migrated profile banner can be longer than the limit through no act of its owner, and
 * refusing every save would leave them unable to edit their own card at all. Shortening is
 * always allowed; growing past the limit never is.
 */
export function assertContentLength(content: string, previousContent?: string) {
  if (content.length <= CREATOR_ANNOUNCEMENT_CONTENT_MAX) return;
  if (previousContent && content.length <= previousContent.length) return;

  throw throwBadRequestError(
    `Announcements are limited to ${CREATOR_ANNOUNCEMENT_CONTENT_MAX} characters.`
  );
}

export const MIN_ANNOUNCEMENT_DURATION_MS = 60 * 60 * 1000;

const MINUTE_MS = 60_000;
const sameMinute = (a: Date, b: Date) =>
  Math.floor(a.getTime() / MINUTE_MS) === Math.floor(b.getTime() / MINUTE_MS);

/**
 * The picker is wall-clock: a creator who selects "in two minutes" then spends five writing submits
 * a start that is already past. Refusing that is a dead end, so the start moves up to now and the
 * end out to clear it by an hour.
 *
 * 🔴 A start the creator did not touch is left alone even when past. Re-stamping it would
 * republish a running announcement to the top of every follower's feed on a typo fix —
 * `getFollowedAnnouncements` orders by `startsAt` desc.
 *
 * "Did not touch" is compared at MINUTE granularity, not by exact timestamp. The composer
 * round-trips a stored start through a `datetime-local`, whose `YYYY-MM-DDTHH:mm` IS a
 * floor-to-the-minute — so a value derived that way always lands in the same bucket as the value it
 * came from, whatever produced the original. That is a property of the transform, not of the
 * widget, and it is what stops a row stamped `new Date()` (every row crossing into notifying) from
 * reading as rescheduled on an edit that changed nothing.
 *
 * REST and tRPC accept arbitrary instants, so two starts under a minute apart CAN read as
 * unchanged there. That direction leaves the start alone, which is the safe one.
 */
export function clampAnnouncementWindow({
  startsAt,
  endsAt,
  previousStartsAt,
  now,
}: {
  startsAt?: Date | null;
  endsAt?: Date | null;
  previousStartsAt?: Date | null;
  now: Date;
}): { startsAt: Date | null; endsAt: Date | null } {
  const untouched = !!startsAt && !!previousStartsAt && sameMinute(startsAt, previousStartsAt);

  const start =
    startsAt && !untouched && startsAt.getTime() < now.getTime() ? now : startsAt ?? null;

  const earliestEnd = (start ?? now).getTime() + MIN_ANNOUNCEMENT_DURATION_MS;
  const end = endsAt && endsAt.getTime() < earliestEnd ? new Date(earliestEnd) : endsAt ?? null;

  return { startsAt: start, endsAt: end };
}

export async function upsertCreatorAnnouncement({
  userId,
  isModerator = false,
  ...input
}: UpsertCreatorAnnouncementSchema & { userId: number; isModerator?: boolean }) {
  const existing = input.id ? await assertOwnedAnnouncement(input.id, userId) : undefined;

  // Push, not pull: this text is delivered to every follower rather than waiting to be visited.
  //
  // AFTER the ownership check, deliberately — same rule as the two creator-shop updates. The
  // rejection names the matched entry, so running it first answers "does this text match the
  // list" for a caller holding an id they do not own, in place of the authorization failure they
  // should get. This is the router's only gate; the procedure passes straight through.
  await throwOnBlockedUserContent(
    [input.title, input.content, input.action?.linkText, input.action?.link],
    { isModerator, surface: 'creatorAnnouncement' }
  );

  // An announcement costs a slot when it starts notifying, not when it is created.
  // profileOnly rows notify nobody, so they are free — but flipping one to profileOnly:
  // false is the moment it gains an audience, and it must pay then. Checking only
  // `!existing` let a creator mint free rows and flip them.
  const willNotify = !input.profileOnly;
  const wasNotifying = existing ? !existing.profileOnly : false;
  const spendsAllowance = willNotify && !wasNotifying;

  const coverId = input.coverImage
    ? await resolveCoverImageId({
        coverImage: input.coverImage,
        userId,
        currentCoverId: existing?.coverId,
        assertOwnership: async (imageId) => {
          if (imageId === existing?.coverId) return;
          const owner = await isImageOwner({ userId, isModerator, imageId });
          if (!owner) throw throwAuthorizationError('Invalid cover image');
        },
      })
    : undefined;

  const metadata: AnnouncementMetaSchema = {
    dismissible: true,
    ...(input.action
      ? {
          actions: [
            {
              type: 'button' as const,
              link: toDomainRelativeLink(input.action.link),
              linkText: input.action.linkText,
            },
          ],
        }
      : {}),
  };

  assertContentLength(input.content, existing?.content);

  const schedule = clampAnnouncementWindow({
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    previousStartsAt: existing?.startsAt,
    now: new Date(),
  });

  const data = {
    title: input.title,
    content: input.content,
    emoji: input.emoji,
    color: input.color ?? 'blue',
    domain: input.domain,
    startsAt: schedule.startsAt,
    endsAt: schedule.endsAt,
    // Never written on an update. A creator cannot set `disabled` at all (the schema has
    // no such field), so a row a moderator took down stays down through any edit.
    ...(existing ? {} : { disabled: false }),
    profileOnly: input.profileOnly,
    metadata,
    ...(coverId !== undefined ? { coverId } : {}),
  };

  if (!spendsAllowance) {
    // The author is set here and never read from input, so this path cannot write a row
    // attributed to anyone else.
    return existing
      ? dbWrite.announcement.update({
          where: { id: existing.id },
          data,
          select: creatorAnnouncementSelect,
        })
      : dbWrite.announcement.create({
          data: { ...data, userId },
          select: creatorAnnouncementSelect,
        });
  }

  const allowance = await getAnnouncementAllowance(userId);
  if (!allowance.eligible)
    throw throwAuthorizationError(
      `Announcements require a creator score of ${allowance.minScore.toLocaleString()}.`
    );

  return dbWrite.$transaction(async (tx) => {
    // Serialises this creator's spend checks against each other. Without it the check is
    // read-then-write and two concurrent creates both see the same free slot.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ANNOUNCEMENT_LOCK_CLASS}::int, ${userId}::int)`;

    // Re-read the row on the WRITER inside the lock. `existing` came from dbRead, and
    // within replica lag it still says profileOnly, so a second save would compute
    // wasNotifying=false and charge the same announcement twice.
    const current = existing
      ? await tx.announcement.findUnique({
          where: { id: existing.id },
          select: { profileOnly: true, spends: { select: { id: true }, take: 1 } },
        })
      : null;
    if (current && (!current.profileOnly || current.spends.length > 0)) {
      return tx.announcement.update({
        where: { id: existing!.id },
        data,
        select: creatorAnnouncementSelect,
      });
    }

    const windowStart = new Date(Date.now() - allowance.windowDays * 24 * 60 * 60 * 1000);
    const spent = await tx.announcementSpend.count({
      where: { userId, createdAt: { gte: windowStart } },
    });

    if (spent >= allowance.limit)
      throw throwBadRequestError(
        allowance.nextAvailableAt
          ? `You have used your ${
              allowance.limit
            } announcement(s) for this period. Next available ${allowance.nextAvailableAt.toDateString()}.`
          : 'You have used your announcements for this period.'
      );

    const announcement = existing
      ? await tx.announcement.update({
          where: { id: existing.id },
          // A row crossing into notifying starts its life now. `getFollowedAnnouncements` orders
          // by startsAt desc NULLS LAST, so a draft that keeps a null start is charged a slot and
          // then lands at the bottom of every follower's feed.
          data: { ...data, startsAt: data.startsAt ?? new Date() },
          select: creatorAnnouncementSelect,
        })
      : await tx.announcement.create({
          data: { ...data, userId },
          select: creatorAnnouncementSelect,
        });

    await tx.announcementSpend.create({ data: { userId, announcementId: announcement.id } });

    return announcement;
  });
}

export async function deleteCreatorAnnouncement({
  id,
  userId,
  isModerator = false,
}: {
  id: number;
  userId: number;
  isModerator?: boolean;
}) {
  await assertOwnedAnnouncement(id, userId, isModerator);
  return dbWrite.announcement.delete({ where: { id }, select: { id: true } });
}

export async function toggleAnnouncementMute({
  userId,
  creatorId,
  muted,
}: {
  userId: number;
  creatorId: number;
  muted: boolean;
}) {
  if (userId === creatorId) throw throwBadRequestError('You cannot mute yourself');

  if (muted) {
    await dbWrite.userAnnouncementMute.upsert({
      where: { userId_creatorId: { userId, creatorId } },
      create: { userId, creatorId },
      update: {},
    });
  } else {
    await dbWrite.userAnnouncementMute.deleteMany({ where: { userId, creatorId } });
  }

  return { muted };
}

export async function isAnnouncementCreatorMuted({
  userId,
  creatorId,
}: {
  userId: number;
  creatorId: number;
}) {
  const row = await dbRead.userAnnouncementMute.findUnique({
    where: { userId_creatorId: { userId, creatorId } },
    select: { userId: true },
  });
  return !!row;
}

export async function getMutedAnnouncementCreators(userId: number) {
  const rows = await dbRead.userAnnouncementMute.findMany({
    where: { userId },
    select: { creatorId: true },
  });
  return rows.map((x) => x.creatorId);
}
