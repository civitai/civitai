import { createHash } from 'crypto';
import { SignalTopic } from '~/server/common/enums';
import { REDIS_SUB_KEYS, REDIS_SYS_KEYS } from '~/server/redis/client';
import type { EventHat, EventPointEntityType, EventPointType } from './types';

// Every live key for one event, on sysRedis under `event:{event}:points:`.
export function eventPointKeys(event: string) {
  const root = `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}` as const;
  return {
    // type -> points one action is worth
    weights: `${root}:weights` as const,
    // `entityType:entityId` -> the hat it wears now (encodeHat). Written by the equip path and the
    // hourly reconcile; each app server loads it once, then follows hatsLog.
    hats: `${root}:hats` as const,
    // Stream of changes to `hats` (fields k = entity key, v = encoded hat, '' when it came off).
    hatsLog: `${root}:hats-log` as const,
    // hats whose total moved since the signals ticker last drained it
    changed: `${root}:changed` as const,
  } as const;
}

// When a scored event's points machinery runs at all: from the preview (or the start) until scoring
// finalizes. Whether an action counts is narrower (it must also fall before endDate).
export const eventPointsWindow = (event: {
  previewFrom?: Date;
  startDate: Date;
  endDate: Date;
  scoring: { finalizeAfterMs: number };
}) => ({
  from: event.previewFrom ?? event.startDate,
  to: new Date(event.endDate.getTime() + event.scoring.finalizeAfterMs),
});

// A scored event's preview (flagged testers, before the start) and the event itself keep separate
// dedupe, cap and total keys, so nothing a tester did before launch counts, or blocks, after it.
export type EventPointSeason = 'preview' | 'live';
export const eventPointSeason = (startDate: Date, now: Date): EventPointSeason =>
  now < startDate ? 'preview' : 'live';

export function eventSeasonKeys(event: string, season: EventPointSeason) {
  const root = `${REDIS_SYS_KEYS.EVENT}:${event}:${REDIS_SUB_KEYS.EVENT.POINTS}:${season}` as const;
  return {
    // user ids that already earned `type` on this entity (per UTC day for once:'day' types)
    seen: (
      type: EventPointType,
      entityType: EventPointEntityType,
      entityId: number,
      day?: string
    ) => `${root}:seen:${type}:${entityType}:${entityId}${day ? `:${day}` : ''}` as const,
    // person -> points given to this creator on this UTC day
    cap: (day: string, ownerId: number) => `${root}:cap:${day}:${ownerId}` as const,
    // exact totals as of the referee's last cut-off
    base: (scope: TotalScope) => `${root}:base:${scope}` as const,
    // points granted live in one 5-minute bucket
    live: (bucket: number, scope: TotalScope) => `${root}:live:${bucket}:${scope}` as const,
    // the bucket the referee last settled up to
    cut: `${root}:cut` as const,
  } as const;
}
export type TotalScope = 'hat' | 'team' | 'owner';

export const hatField = ({ ownerId, cosmeticId, claimKey }: Omit<EventHat, 'team'>) =>
  `${ownerId}:${cosmeticId}:${claimKey}`;
// The claim key goes last and keeps any colons it has.
export function parseHatField(field: string): Omit<EventHat, 'team'> | undefined {
  const [ownerId, cosmeticId, ...claim] = field.split(':');
  if (!claim.length || !Number(ownerId) || !Number(cosmeticId)) return undefined;
  return { ownerId: Number(ownerId), cosmeticId: Number(cosmeticId), claimKey: claim.join(':') };
}

export const entityKey = (entityType: EventPointEntityType, entityId: number) =>
  `${entityType}:${entityId}`;
export const encodeHat = (hat: EventHat) => JSON.stringify(hat);
export function decodeHat(value: string): EventHat | undefined {
  try {
    const hat = JSON.parse(value) as Partial<EventHat>;
    if (!hat.ownerId || !hat.cosmeticId || typeof hat.claimKey !== 'string' || !hat.team)
      return undefined;
    return {
      ownerId: hat.ownerId,
      cosmeticId: hat.cosmeticId,
      claimKey: hat.claimKey,
      team: hat.team,
    };
  } catch {
    return undefined;
  }
}

// A hat's public id: what its signals topic is named by and what the client subscribes with. Opaque,
// because a bought hat's claim key is the purchase's transaction id.
export const hatTopicId = (hat: Omit<EventHat, 'team'>) =>
  createHash('sha256').update(hatField(hat)).digest('hex').slice(0, 16);
// The signals topic a hat's live total is pushed to. Clients subscribe while its popover or the
// owner's hat cards are open.
export const eventHatTopic = (event: string, topicId: string) =>
  `${SignalTopic.EventPoints}:${event}:hat:${topicId}` as const;
// One topic for the event page's team standings.
export const eventTeamsTopic = (event: string) =>
  `${SignalTopic.EventPoints}:${event}:teams` as const;

export const LIVE_BUCKET_MS = 5 * 60 * 1000;
export const liveBucket = (time: Date) => Math.floor(time.getTime() / LIVE_BUCKET_MS);
export const utcDay = (time: Date) => time.toISOString().slice(0, 10);
