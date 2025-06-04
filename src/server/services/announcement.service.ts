import { CacheTTL } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import type {
  AnnouncementMetaSchema,
  GetAnnouncementsPagedSchema,
  UpsertAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

export async function upsertAnnouncement(data: UpsertAnnouncementSchema) {
  const result = data.id
    ? await dbWrite.announcement.update({ where: { id: data.id }, data })
    : await dbWrite.announcement.create({ data });

  await redis.del(REDIS_KEYS.CACHES.ANNOUNCEMENTS);
  return result;
}

export async function deleteAnnouncement(id: number) {
  await dbWrite.announcement.delete({ where: { id } });
  await redis.del(REDIS_KEYS.CACHES.ANNOUNCEMENTS);
}

export async function getAnnouncementsPaged(data: GetAnnouncementsPagedSchema) {
  const { limit = DEFAULT_PAGE_SIZE, page } = data ?? {};
  const { take, skip } = getPagination(limit, page);

  const items = await dbWrite.announcement.findMany({
    skip,
    take,
    select: {
      id: true,
      createdAt: true,
      startsAt: true,
      endsAt: true,
      title: true,
      content: true,
      color: true,
      disabled: true,
      metadata: true,
      emoji: true,
    },
    orderBy: { startsAt: { sort: 'desc', nulls: 'last' } },
  });

  const count = await dbWrite.announcement.count();
  return getPagingData(
    {
      items: items.map((item) => ({
        ...item,
        startsAt: item.startsAt ?? new Date(),
        metadata: (item.metadata ?? {}) as AnnouncementMetaSchema,
      })),
      count,
    },
    limit,
    page
  );
}

export async function getCurrentAnnouncements({ userId }: { userId?: number }) {
  const announcements = await getAnnouncementsCached();
  const now = Date.now();

  return announcements.filter((announcement) => {
    if (!userId && announcement.metadata.targetAudience === 'authenticated') return false;
    if (!!userId && announcement.metadata.targetAudience === 'unauthenticated') return false;
    const startsAt = new Date(announcement.startsAt ?? now).getTime();
    const endsAt = new Date(announcement.endsAt ?? '2100-12-31').getTime();
    if (startsAt <= now && now <= endsAt) return true;
    return false;
  });
}

async function getAnnouncementsCached() {
  const cached = await redis.get(REDIS_KEYS.CACHES.ANNOUNCEMENTS);
  if (cached) return JSON.parse(cached) as AnnouncementDTO[];

  const announcements = await getAnnouncements();

  await redis.set(REDIS_KEYS.CACHES.ANNOUNCEMENTS, JSON.stringify(announcements), {
    EX: CacheTTL.day,
  });

  return announcements;
}

export type AnnouncementDTO = Awaited<ReturnType<typeof getAnnouncements>>[number];
async function getAnnouncements() {
  const now = new Date();
  const announcements = await dbWrite.announcement.findMany({
    where: {
      disabled: false,
      AND: [
        {
          OR: [{ startsAt: { lte: now } }, { startsAt: { equals: null } }],
        },
        {
          OR: [{ endsAt: { gte: now } }, { endsAt: { equals: null } }],
        },
      ],
    },
    select: {
      createdAt: true,
      startsAt: true,
      endsAt: true,
      id: true,
      title: true,
      content: true,
      color: true,
      emoji: true,
      metadata: true,
    },
    orderBy: { startsAt: { sort: 'desc', nulls: 'last' } },
  });

  return announcements.map(({ createdAt, metadata, startsAt, ...x }) => ({
    ...x,
    createdAt,
    startsAt: startsAt ?? createdAt,
    metadata: (metadata ?? {}) as AnnouncementMetaSchema,
  }));
}
