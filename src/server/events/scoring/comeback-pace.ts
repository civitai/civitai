import * as z from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { loadEvents } from '~/server/events/load-events';
import { readFlagRaceJson } from '~/server/events/scoring/award-results';
import {
  comebackCup,
  comebackTeams,
  parseEventPrizes,
  type PrizeEvent,
} from '~/server/events/scoring/event-prizes';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type ComebackPace = {
  teams: { team: string; pct: number }[];
  // ISO strings, so a cached copy reads the same as a fresh one.
  week: { from: string; to: string };
  badge: { url: string; animated: boolean } | null;
};

/**
 * Each team's week so far against its own pace, as a whole percent, best first. The week points are
 * spread over the part of the week played (at least an hour), so the race reads fairly mid-week.
 * Null when the Cup is not configured, is off, or its week has not started.
 */
export async function comebackPace(
  event: PrizeEvent,
  flagRaceJson: unknown,
  now = new Date()
): Promise<ComebackPace | null> {
  const comeback = parseEventPrizes(flagRaceJson)?.comeback;
  if (!comeback || comeback.mode === 'off') return null;
  const { week } = comeback;
  if (now < week.from) return null;
  const elapsedMs = Math.min(
    week.to.getTime() - week.from.getTime(),
    Math.max(HOUR_MS, now.getTime() - week.from.getTime())
  );
  const [teams, cosmetic] = await Promise.all([
    comebackTeams(event, comeback, dbRead),
    dbRead.cosmetic.findUnique({ where: { id: comeback.badge }, select: { data: true } }),
  ]);
  const { teams: scored } = comebackCup(teams, comeback, elapsedMs / DAY_MS);
  const data = cosmetic?.data as { url?: string; animated?: boolean } | null | undefined;
  return {
    teams: scored
      .map(({ team, ratio }) => ({ team, pct: Math.round((ratio - 1) * 100) }))
      .sort((a, b) => b.pct - a.pct || a.team.localeCompare(b.team)),
    week: { from: week.from.toISOString(), to: week.to.toISOString() },
    badge: data?.url ? { url: data.url, animated: !!data.animated } : null,
  };
}

/** The event page's Comeback Cup race: the same for every viewer, so cached briefly. */
export async function getComebackPace(eventName: string): Promise<ComebackPace | null> {
  const event = (await loadEvents()).find((e) => e.name === eventName);
  if (!event?.scoring) return null;
  const key = `${REDIS_KEYS.EVENT.CACHE}:${eventName}:comeback-pace` as RedisKeyTemplateCache;
  return fetchThroughCache(
    key,
    async () => comebackPace(event, await readFlagRaceJson(eventName)),
    {
      ttl: CacheTTL.md,
    }
  );
}

const film = {
  /** A full URL or a CDN id; absent hides the play button. */
  video: z.string().min(1).optional(),
  /** Seconds. */
  duration: z.number().nonnegative().optional(),
};
// The `media` field of the flagRace key, so a film or cover lands without a deploy.
const eventMediaSchema = z.object({
  flagRace: z.object(film).optional(),
  comeback: z.object({ ...film, art: z.string().min(1).optional() }).optional(),
});
export type EventMedia = z.infer<typeof eventMediaSchema>;

export async function getEventMedia(eventName: string): Promise<EventMedia> {
  const json = await readFlagRaceJson(eventName).catch(() => undefined);
  const media = (json as { media?: unknown } | undefined)?.media;
  if (media === undefined) return {};
  const parsed = eventMediaSchema.safeParse(media);
  if (parsed.success) return parsed.data;
  logToAxiom({ type: 'error', name: 'event-media-invalid', event: eventName });
  return {};
}
