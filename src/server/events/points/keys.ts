import { REDIS_SUB_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import type { EventHat, EventPointEntityType, EventPointType } from './types';

// Every live key for one event, on sysRedis under `event:{event}:points:`. sysRedis is a single
// Sentinel master, so the award script can touch any of them in one call.
export function eventPointKeys(event: string) {
  const root = `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}`;
  return {
    // type -> points one action is worth
    weights: `${root}:weights`,
    // the hat an entity wears now, as `ownerId|cosmeticId|claimKey|team`
    hat: (entityType: EventPointEntityType, entityId: number) =>
      `${root}:hat:${entityType}:${entityId}`,
    // every hatted `entityType:entityId`, mirrored into app memory for the view hot path
    hatted: `${root}:hatted`,
    // user ids that already earned `type` on this entity (per UTC day for once:'day' types)
    seen: (
      type: EventPointType,
      entityType: EventPointEntityType,
      entityId: number,
      day?: string
    ) => `${root}:seen:${type}:${entityType}:${entityId}${day ? `:${day}` : ''}`,
    // person -> points given to this creator on this UTC day
    cap: (day: string, ownerId: number) => `${root}:cap:${day}:${ownerId}`,
    // exact totals as of the referee's last cut-off
    base: (scope: 'hat' | 'team' | 'owner') => `${root}:base:${scope}`,
    // points granted live in one 5-minute bucket
    live: (bucket: number, scope: 'hat' | 'team' | 'owner') => `${root}:live:${bucket}:${scope}`,
    // the bucket the referee last settled up to
    cut: `${root}:cut`,
    // hats whose total moved since the signals ticker last drained it
    changed: `${root}:changed`,
  } as const;
}

export const hatField = ({ ownerId, cosmeticId, claimKey }: Omit<EventHat, 'team'>) =>
  `${ownerId}:${cosmeticId}:${claimKey}`;

// The signals topic a hat's live total is pushed to. Clients subscribe while its popover or the
// owner's hat cards are open.
export const eventHatTopic = (event: string, hat: Omit<EventHat, 'team'>) =>
  `event-points:${event}:hat:${hatField(hat)}`;
// One topic for the event page's team standings.
export const eventTeamsTopic = (event: string) => `event-points:${event}:teams`;

export const LIVE_BUCKET_MS = 5 * 60 * 1000;
export const liveBucket = (time: Date) => Math.floor(time.getTime() / LIVE_BUCKET_MS);
export const utcDay = (time: Date) => time.toISOString().slice(0, 10);
