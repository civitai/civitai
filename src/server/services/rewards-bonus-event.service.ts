import { dbRead, dbWrite } from '~/server/db/client';
import type {
  GetRewardsBonusEventsPagedSchema,
  UpsertRewardsBonusEventSchema,
} from '~/server/schema/rewards-bonus-event.schema';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';

const ENABLED_EVENTS_TTL_MS = 5 * 60 * 1000;

export type ActiveRewardsBonusEvent = {
  id: number;
  name: string;
  description: string | null;
  multiplier: number;
  articleId: number | null;
  bannerLabel: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
};

type CacheEntry = {
  events: ActiveRewardsBonusEvent[];
  expiresAt: number;
};

// Cache the list of `enabled: true` events, not the time-filtered result.
// Time boundaries are evaluated against the current instant on every call so
// that scheduled start/end transitions take effect immediately instead of
// waiting for cache expiry.
let enabledEventsCache: CacheEntry | null = null;

function invalidateEnabledEventsCache() {
  enabledEventsCache = null;
}

async function getEnabledEvents(): Promise<ActiveRewardsBonusEvent[]> {
  const now = Date.now();
  if (enabledEventsCache && enabledEventsCache.expiresAt > now) return enabledEventsCache.events;

  const events = await dbRead.rewardsBonusEvent.findMany({
    where: { enabled: true },
    orderBy: [{ multiplier: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      description: true,
      multiplier: true,
      articleId: true,
      bannerLabel: true,
      startsAt: true,
      endsAt: true,
    },
  });

  enabledEventsCache = { events, expiresAt: now + ENABLED_EVENTS_TTL_MS };
  return events;
}

export async function getActiveRewardsBonusEvent(): Promise<ActiveRewardsBonusEvent | null> {
  const events = await getEnabledEvents();
  const current = new Date();
  return (
    events.find(
      (event) =>
        (!event.startsAt || event.startsAt <= current) &&
        (!event.endsAt || event.endsAt >= current)
    ) ?? null
  );
}

export async function upsertRewardsBonusEvent(
  data: UpsertRewardsBonusEventSchema,
  userId: number
) {
  const { id, ...fields } = data;
  const payload = {
    name: fields.name,
    description: fields.description ?? null,
    multiplier: fields.multiplier,
    articleId: fields.articleId ?? null,
    bannerLabel: fields.bannerLabel ?? null,
    enabled: fields.enabled,
    startsAt: fields.startsAt ?? null,
    endsAt: fields.endsAt ?? null,
  };

  const result = id
    ? await dbWrite.rewardsBonusEvent.update({ where: { id }, data: payload })
    : await dbWrite.rewardsBonusEvent.create({
        data: { ...payload, createdById: userId },
      });

  invalidateEnabledEventsCache();
  return result;
}

export async function deleteRewardsBonusEvent(id: number) {
  await dbWrite.rewardsBonusEvent.delete({ where: { id } });
  invalidateEnabledEventsCache();
}

export async function getRewardsBonusEventById(id: number) {
  return dbRead.rewardsBonusEvent.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      multiplier: true,
      articleId: true,
      bannerLabel: true,
      enabled: true,
      startsAt: true,
      endsAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export async function getRewardsBonusEventsPaged(data: GetRewardsBonusEventsPagedSchema) {
  const { limit = DEFAULT_PAGE_SIZE, page } = data ?? {};
  const { take, skip } = getPagination(limit, page);

  const [items, count] = await dbRead.$transaction([
    dbRead.rewardsBonusEvent.findMany({
      skip,
      take,
      orderBy: [{ enabled: 'desc' }, { startsAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      select: {
        id: true,
        name: true,
        description: true,
        multiplier: true,
        articleId: true,
        bannerLabel: true,
        enabled: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    dbRead.rewardsBonusEvent.count(),
  ]);

  return getPagingData({ items, count }, limit, page);
}
