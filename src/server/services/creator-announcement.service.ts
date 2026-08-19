import { dbRead, dbWrite } from '~/server/db/client';
import type {
  AnnouncementMetaSchema,
  UpsertCreatorAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import { getAnnouncementAllowance } from '~/server/services/announcement-allowance.service';
import { resolveCoverImageId } from '~/server/services/cover-image.service';
import { isImageOwner } from '~/server/services/util.service';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { DomainColor, UserEngagementType } from '~/shared/utils/prisma/enums';

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
  nsfwLevel: true,
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
} as const;

type RawCreatorAnnouncement = {
  nsfwLevel: number;
  metadata: unknown;
  cover: { nsfwLevel: number } | null;
};

/**
 * The announcement is never safer than what it shows. Same rule as an article and its
 * cover (`article.service.ts:551`) — computed here because a client holding an id cannot
 * do it, and a client trusted to do it would be the gap.
 */
function withEffectiveNsfwLevel<T extends RawCreatorAnnouncement>(announcement: T) {
  return {
    ...announcement,
    // Parsed here, as the sitewide DTO does, so the client reads metadata.actions
    // without a cast rather than being trusted to know the shape.
    metadata: (announcement.metadata ?? {}) as AnnouncementMetaSchema,
    nsfwLevel: Math.max(announcement.nsfwLevel ?? 0, announcement.cover?.nsfwLevel ?? 0),
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
}: {
  userId: number;
  limit?: number;
  includeHidden?: boolean;
}) {
  const now = new Date();

  const announcements = await dbRead.announcement.findMany({
    where: {
      userId,
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

  return announcements.map(withEffectiveNsfwLevel);
}

/**
 * The *Creators* chip: live announcements from authors the caller follows.
 *
 * Muted creators are absent entirely, not merely un-pinged. A mute that silenced the
 * notification but left the posts in the feed would not be the escape hatch the ticket
 * asked for — the follower would still be reading what they opted out of.
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
        engagedUsers: { some: { userId, type: UserEngagementType.Follow } },
        announcementMutesReceived: { none: { userId } },
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

  const items = announcements.slice(0, limit).map(withEffectiveNsfwLevel);

  return { items, nextCursor: announcements.length > limit ? items[items.length - 1]?.id : undefined };
}

/**
 * `isModerator` widens this to any *authored* announcement — never to a platform row, which
 * has its own moderator tooling. Matches what moderators can already do to the profile
 * message this feature replaces: remove it in place, from wherever it is shown.
 */
async function assertOwnedAnnouncement(id: number, userId: number, isModerator = false) {
  const existing = await dbRead.announcement.findFirst({
    where: isModerator ? { id, userId: { not: null } } : { id, userId },
    select: { id: true, coverId: true, profileOnly: true },
  });
  if (!existing) throw throwAuthorizationError('Announcement not found');
  return existing;
}

export async function upsertCreatorAnnouncement({
  userId,
  isModerator = false,
  ...input
}: UpsertCreatorAnnouncementSchema & { userId: number; isModerator?: boolean }) {
  const existing = input.id ? await assertOwnedAnnouncement(input.id, userId) : undefined;

  // Profile-only rows never notify, so they are not throttled. The allowance exists to
  // bound what lands in other people's notifications, and this lands in nobody's.
  const spendsAllowance = !input.profileOnly && !existing?.profileOnly;
  if (spendsAllowance && !existing) {
    const allowance = await getAnnouncementAllowance(userId);
    if (!allowance.eligible)
      throw throwAuthorizationError(
        `Announcements require a creator score of ${allowance.minScore.toLocaleString()}.`
      );
    if (allowance.used >= allowance.limit)
      throw throwBadRequestError(
        allowance.nextAvailableAt
          ? `You have used your ${allowance.limit} announcement(s) for this period. Next available ${allowance.nextAvailableAt.toDateString()}.`
          : 'You have used your announcements for this period.'
      );
  }

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
      ? { actions: [{ type: 'button' as const, link: input.action.link, linkText: input.action.linkText }] }
      : {}),
  };

  const data = {
    title: input.title,
    content: input.content,
    emoji: input.emoji,
    color: input.color ?? 'blue',
    domain: input.domain,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    disabled: input.disabled ?? false,
    profileOnly: input.profileOnly,
    metadata,
    ...(coverId !== undefined ? { coverId } : {}),
  };

  // The author is set here and never read from input, so this path cannot write a row
  // attributed to anyone else.
  return existing
    ? dbWrite.announcement.update({ where: { id: existing.id }, data, select: creatorAnnouncementSelect })
    : dbWrite.announcement.create({ data: { ...data, userId }, select: creatorAnnouncementSelect });
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
