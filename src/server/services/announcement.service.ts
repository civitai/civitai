import type { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import type {
  AnnouncementMetaSchema,
  GetAnnouncementsPagedSchema,
  UpsertAnnouncementSchema,
} from '~/server/schema/announcement.schema';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { DomainColor } from '~/shared/utils/prisma/enums';
import { createKeyedTtlMemo } from '~/server/utils/ttl-memoize';

const domainColors = Object.values(DomainColor);
const announcementRedisKeys = ['', ...domainColors].map((domain) =>
  domain ? `${REDIS_KEYS.CACHES.ANNOUNCEMENTS}:${domain}` : REDIS_KEYS.CACHES.ANNOUNCEMENTS
) as RedisKeyTemplateCache[];

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

// This redis read is GLOBAL per domain — the per-user (targetAudience) + active
// time-window filter is applied by getCurrentAnnouncements AFTER this, in JS — so
// it is safe to memoize per domain (a bounded DomainColor set). Collapses the
// frequent redis.get + JSON.parse into ~1 read / TTL / pod. The announcement
// caches are redis.del-invalidated on upsert/delete, so the in-proc memo adds at
// most this TTL of per-pod propagation on top of that del; announcements are also
// start/end-time gated downstream, so a few seconds is invisible. Keyed by
// `domain ?? ''` (empty string = the no-domain default cache). The only consumer
// (getCurrentAnnouncements) reads it via .filter() into a new array, so it opts
// into { freeze: true } to structurally reject a future in-place mutation of the
// shared per-domain array.
const ANNOUNCEMENTS_INPROC_TTL_MS = 30_000;

const getAnnouncementsCachedMemo = createKeyedTtlMemo<AnnouncementDTO[]>(
  async (domainKey) => {
    const domain = (domainKey || undefined) as DomainColor | undefined;
    const cacheKey: RedisKeyTemplateCache = domain
      ? `${REDIS_KEYS.CACHES.ANNOUNCEMENTS}:${domain as string}`
      : REDIS_KEYS.CACHES.ANNOUNCEMENTS;

    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as AnnouncementDTO[];

    const announcements = await getAnnouncements(domain);

    await redis.set(cacheKey, JSON.stringify(announcements), {
      EX: CacheTTL.day,
    });

    return announcements;
  },
  ANNOUNCEMENTS_INPROC_TTL_MS,
  undefined,
  { freeze: true }
);

async function getAnnouncementsCached(domain?: DomainColor) {
  return getAnnouncementsCachedMemo(domain ?? '');
}

/**
 * Enabled announcements whose (open-ended) start/end window overlaps `[from, to]`.
 *
 * The single source of truth for "is this announcement showing". `activeAnnouncementWhere`
 * is the degenerate `from === to === now` case used by the read path; the media health
 * check widens only the upper bound so it can see a banner before it goes live.
 */
export function announcementWindowOverlapsWhere(
  from: Date,
  to: Date
): Prisma.AnnouncementWhereInput {
  return {
    disabled: false,
    AND: [
      {
        OR: [{ startsAt: { lte: to } }, { startsAt: { equals: null } }],
      },
      {
        OR: [{ endsAt: { gte: from } }, { endsAt: { equals: null } }],
      },
    ],
  };
}

/**
 * The "currently live" predicate: enabled, and now is inside the (open-ended)
 * start/end window. Shared with the announcement media health check so a monitor
 * can never disagree with the read path about which announcements are live.
 */
export function activeAnnouncementWhere(now: Date): Prisma.AnnouncementWhereInput {
  return announcementWindowOverlapsWhere(now, now);
}

/**
 * How far ahead of "now" the media health check looks.
 *
 * The check runs hourly, so a monitor limited to *currently-live* announcements would
 * find a broken banner up to an hour after it went live — i.e. users see it first. One
 * day of look-ahead means a scheduled announcement's banner is verified well before it
 * is shown, and costs nothing: the extra rows are few and their keys de-duplicate
 * against the live ones. A finding on a not-yet-live announcement is just as actionable,
 * and cheaper to fix.
 */
export const ANNOUNCEMENT_MEDIA_LOOKAHEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Every announcement that carries a banner image key and is either live now or goes
 * live within `lookaheadMs`, across all domains. Used by the media health check —
 * deliberately NOT domain-filtered, since a broken banner on a single-domain
 * announcement is just as broken.
 */
export async function getMonitoredAnnouncementImageRefs(
  lookaheadMs: number = ANNOUNCEMENT_MEDIA_LOOKAHEAD_MS
) {
  const now = new Date();
  const announcements = await dbRead.announcement.findMany({
    where: announcementWindowOverlapsWhere(now, new Date(now.getTime() + lookaheadMs)),
    select: { id: true, metadata: true },
  });

  return announcements
    .map(({ id, metadata }) => ({
      id,
      key: ((metadata ?? {}) as AnnouncementMetaSchema).image,
    }))
    .filter((x): x is { id: number; key: string } => !!x.key);
}

export type AnnouncementDTO = Awaited<ReturnType<typeof getAnnouncements>>[number];
async function getAnnouncements(domain?: DomainColor) {
  const now = new Date();
  const announcements = await dbWrite.announcement.findMany({
    where: {
      ...activeAnnouncementWhere(now),
      domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
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
