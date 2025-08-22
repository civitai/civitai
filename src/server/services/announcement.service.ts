import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import type {
  AnnouncementMetaSchema,
  GetAnnouncementsPagedSchema,
  UpsertAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { DomainColor } from '~/shared/utils/prisma/enums';

const domainColors = Object.values(DomainColor);
const announcementRedisKeys = ['', ...domainColors].map((domain) =>
  domain
    ? (`${REDIS_KEYS.CACHES.ANNOUNCEMENTS}:${domain as string}` as const)
    : REDIS_KEYS.CACHES.ANNOUNCEMENTS
);

export async function upsertAnnouncement(data: UpsertAnnouncementSchema) {
  const result = data.id
    ? await dbWrite.announcement.update({ where: { id: data.id }, data })
    : await dbWrite.announcement.create({ data });

  // Clear all announcement caches when upserting
  await redis.del(announcementRedisKeys);

  return result;
}

export async function deleteAnnouncement(id: number) {
  await dbWrite.announcement.delete({ where: { id } });

  // Clear all announcement caches when deleting
  await redis.del(announcementRedisKeys);
}

export async function getAnnouncementsPaged(data: GetAnnouncementsPagedSchema) {
  const { limit = DEFAULT_PAGE_SIZE, page } = data ?? {};
  const { take, skip } = getPagination(limit, page);

  const [items, count] = await dbRead.$transaction([
    dbRead.announcement.findMany({
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
        domain: true,
        disabled: true,
        metadata: true,
        emoji: true,
      },
      orderBy: { startsAt: { sort: 'desc', nulls: 'last' } },
    }),
    dbRead.announcement.count(),
  ]);

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

export async function getCurrentAnnouncements({
  userId,
  domain,
}: {
  userId?: number;
  domain?: DomainColor;
}) {
  const announcements = await getAnnouncementsCached(domain);
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

async function getAnnouncementsCached(domain?: DomainColor) {
  const cacheKey = domain
    ? `${REDIS_KEYS.CACHES.ANNOUNCEMENTS}:${domain as string}`
    : REDIS_KEYS.CACHES.ANNOUNCEMENTS;

  // @ts-expect-error - Redis get accepts dynamic keys
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as AnnouncementDTO[];

  const announcements = await getAnnouncements(domain);

  // @ts-expect-error - Redis set accepts dynamic keys
  await redis.set(cacheKey, JSON.stringify(announcements), {
    EX: CacheTTL.day,
  });

  return announcements;
}

export type AnnouncementDTO = Awaited<ReturnType<typeof getAnnouncements>>[number];
async function getAnnouncements(domain?: DomainColor) {
  const now = new Date();
  const announcements = await dbWrite.announcement.findMany({
    where: {
      disabled: false,
      domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
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
