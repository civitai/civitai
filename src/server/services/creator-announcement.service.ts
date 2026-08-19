import { dbRead, dbWrite } from '~/server/db/client';
import type {
  AnnouncementMetaSchema,
  UpsertCreatorAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import { getAnnouncementAllowance } from '~/server/services/announcement-allowance.service';
import { resolveCoverImageId } from '~/server/services/cover-image.service';
import { isImageOwner } from '~/server/services/util.service';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';

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
} as const;

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

  return dbRead.announcement.findMany({
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
}

async function assertOwnedAnnouncement(id: number, userId: number) {
  const existing = await dbRead.announcement.findFirst({
    where: { id, userId },
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

export async function deleteCreatorAnnouncement({ id, userId }: { id: number; userId: number }) {
  await assertOwnedAnnouncement(id, userId);
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

export async function getMutedAnnouncementCreators(userId: number) {
  const rows = await dbRead.userAnnouncementMute.findMany({
    where: { userId },
    select: { creatorId: true },
  });
  return rows.map((x) => x.creatorId);
}
