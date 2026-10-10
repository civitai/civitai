import { chunk } from 'lodash-es';
import { dbRead } from '~/server/db/client';
import type { EventScoring } from '~/server/events/base.event';
import {
  flagAudienceAmong,
  getEventScoringPhase,
  type GatedEvent,
} from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { isEventPointsEnabled } from '~/server/events/points/enabled';
import {
  encodeHat,
  entityKey,
  eventPointKeys,
  eventPointsWindow,
} from '~/server/events/points/keys';
import type { EventHat, EventPointEntityType } from '~/server/events/points/types';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';

// Enough log for an app server that missed a few refreshes; one further behind reloads the hash.
const HATS_LOG_MAX = 50_000;

type OpenPlacement = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  team: string;
  entityType: EventPointEntityType;
  entityId: number;
};

// The hats that may earn points right now: open placements on their owner's own content, owners not
// banned, deleted or excluded from leaderboards, and during the preview only owners the flag is on
// for. One entity wearing two event hats scores for the one placed first.
export async function desiredEventHats(
  event: { name: string; entityTypes: readonly EventPointEntityType[] },
  fliptKey: string | undefined
) {
  const rows = await dbRead.$queryRaw<OpenPlacement[]>`
    SELECT p."userId", p."cosmeticId", p."claimKey", p.team, p."entityType", p."entityId"
    FROM "EventCosmeticPlacement" p
    JOIN "User" u ON u.id = p."userId"
    WHERE p.event = ${event.name}
      AND p."endedAt" IS NULL
      AND p."entityOwnerId" = p."userId"
      AND p."entityType"::text = ANY(${[...event.entityTypes]}::text[])
      AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL AND NOT u."excludeFromLeaderboards"
    ORDER BY p."startedAt", p.id
  `;
  const audience = fliptKey
    ? await flagAudienceAmong(fliptKey, [...new Set(rows.map((r) => r.userId))])
    : undefined;
  const hats = new Map<string, string>();
  for (const r of rows) {
    if (audience && !audience.has(r.userId)) continue;
    const key = entityKey(r.entityType, r.entityId);
    if (hats.has(key)) continue;
    const hat: EventHat = {
      ownerId: r.userId,
      cosmeticId: r.cosmeticId,
      claimKey: r.claimKey,
      team: r.team,
    };
    hats.set(key, encodeHat(hat));
  }
  return hats;
}

// What to write so `current` becomes `desired`: changed or new entries, and keys to remove.
export function diffHats(current: Record<string, string>, desired: Map<string, string>) {
  const set: [string, string][] = [];
  const remove: string[] = [];
  for (const [key, value] of desired) if (current[key] !== value) set.push([key, value]);
  for (const key of Object.keys(current)) if (!desired.has(key)) remove.push(key);
  return { set, remove };
}

// Mirrors which content wears which hat into sysRedis, and seeds the live weights from the event
// config where none are set. Runs every minute; the referee runs it too before settling.
export async function syncEventHats(now = new Date()) {
  const results: { event: string; set: number; removed: number }[] = [];
  if (!(await isEventPointsEnabled())) return results;
  const events = await loadEvents();
  for (const eventDef of events) {
    const { scoring } = eventDef;
    if (!scoring) continue;
    if (now > eventPointsWindow({ ...eventDef, scoring }).to) continue;
    // One event failing (an unreadable flag throws) must not stop the others' hats syncing.
    try {
      results.push(await syncOneEvent({ ...eventDef, scoring }, now));
    } catch (error) {
      logToAxiom({
        type: 'error',
        name: 'event-points',
        fn: 'syncEventHats',
        event: eventDef.name,
        error,
      }).catch(() => undefined);
    }
  }
  return results;
}

async function syncOneEvent(
  eventDef: GatedEvent & { endDate: Date; scoring: EventScoring },
  now: Date
) {
  const { scoring } = eventDef;
  const keys = eventPointKeys(eventDef.name);
  const entityTypes = [
    ...new Set(Object.values(scoring.types).flatMap((rule) => rule?.entities ?? [])),
  ];

  // Outside a scoring window nothing earns, so the desired map is empty and every hat comes off.
  const phase = await getEventScoringPhase(eventDef, now);
  const desired = phase
    ? await desiredEventHats({ name: eventDef.name, entityTypes }, phase.fliptKey)
    : new Map<string, string>();

  const current = (await sysRedis.hGetAll(keys.hats)) ?? {};
  const { set, remove } = diffHats(current, desired);
  // Hash first, then the log entry, so a server that reloads between the two still converges.
  for (const part of chunk(set, 500))
    await Promise.all(part.map(([key, value]) => sysRedis.hSet(keys.hats, key, value)));
  for (const part of chunk(remove, 500))
    await Promise.all(part.map((key) => sysRedis.hDel(keys.hats, key)));
  for (const part of chunk([...set, ...remove.map((key) => [key, ''] as const)], 500))
    await Promise.all(part.map(([k, v]) => sysRedis.xAdd(keys.hatsLog, '*', { k, v })));
  if (set.length || remove.length)
    await sysRedis.xTrim(keys.hatsLog, 'MAXLEN', HATS_LOG_MAX, { strategyModifier: '~' });

  for (const [type, rule] of Object.entries(scoring.types))
    if (rule) await sysRedis.hSetNX(keys.weights, type, String(rule.weight));

  return { event: eventDef.name, set: set.length, removed: remove.length };
}
