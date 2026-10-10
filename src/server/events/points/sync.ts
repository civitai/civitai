import { chunk } from 'lodash-es';
import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { EventScoring } from '~/server/events/base.event';
import {
  flagAudienceAmong,
  getEventScoringPhase,
  type GatedEvent,
} from '~/server/events/event-access';
import { loadEvents } from '~/server/events/load-events';
import { isEventPointsEnabled } from '~/server/events/points/enabled';
import {
  decodeHat,
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
// How many changed keys one reconcile log line names; the counts are always complete.
const LOGGED_KEYS_MAX = 50;

type OpenPlacement = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  team: string;
  entityType: EventPointEntityType;
  entityId: number;
};

type ScoredEvent = GatedEvent & { endDate: Date; scoring: EventScoring };
type HatEntity = { entityType: string; entityId: number };

// The hats that may earn points right now: open placements on their owner's own content, owners not
// banned, deleted or excluded from leaderboards, and during the preview only owners the flag is on
// for. One entity wearing two event hats scores for the one placed first. `ownerId` narrows it to
// one owner's hats, which is the whole answer for their content: only an entity's owner can score on it.
export async function desiredEventHats(
  event: { name: string; entityTypes: readonly EventPointEntityType[] },
  fliptKey: string | undefined,
  { ownerId, db = dbRead }: { ownerId?: number; db?: typeof dbRead | typeof dbWrite } = {}
) {
  const rows = await db.$queryRaw<OpenPlacement[]>`
    SELECT p."userId", p."cosmeticId", p."claimKey", p.team, p."entityType", p."entityId"
    FROM "EventCosmeticPlacement" p
    JOIN "User" u ON u.id = p."userId"
    WHERE p.event = ${event.name}
      AND p."endedAt" IS NULL
      AND p."entityOwnerId" = p."userId"
      AND p."entityType"::text = ANY(${[...event.entityTypes]}::text[])
      AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL AND NOT u."excludeFromLeaderboards"
      ${ownerId ? Prisma.sql`AND p."userId" = ${ownerId}` : Prisma.empty}
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

// Hash first, then the log entry, so a server that reloads between the two still converges.
async function writeHatChanges(
  keys: ReturnType<typeof eventPointKeys>,
  { set, remove }: ReturnType<typeof diffHats>
) {
  for (const part of chunk(set, 500))
    await Promise.all(part.map(([key, value]) => sysRedis.hSet(keys.hats, key, value)));
  for (const part of chunk(remove, 500))
    await Promise.all(part.map((key) => sysRedis.hDel(keys.hats, key)));
  for (const part of chunk([...set, ...remove.map((key) => [key, ''] as const)], 500))
    await Promise.all(part.map(([k, v]) => sysRedis.xAdd(keys.hatsLog, '*', { k, v })));
  if (set.length || remove.length)
    await sysRedis.xTrim(keys.hatsLog, 'MAXLEN', HATS_LOG_MAX, { strategyModifier: '~' });
}

const scoredEntityTypes = (scoring: EventScoring) => [
  ...new Set(Object.values(scoring.types).flatMap((rule) => rule?.entities ?? [])),
];

// Scored events whose hat map may still change: until scoring finalizes.
async function hatSyncEvents(now: Date) {
  const events = await loadEvents();
  const scored: ScoredEvent[] = [];
  for (const eventDef of events) {
    const { scoring } = eventDef;
    if (!scoring) continue;
    if (now > eventPointsWindow({ ...eventDef, scoring }).to) continue;
    scored.push({ ...eventDef, scoring });
  }
  return scored;
}

const logSyncError = (fn: string, error: unknown, extra: object) =>
  logToAxiom({ type: 'error', name: 'event-points', fn, error, ...extra }).catch(() => undefined);

// The safety net under the write-through: rebuilds which content wears which hat from the
// placements, and seeds the live weights from the event config where none are set. Runs hourly; the
// referee runs it too before settling. Every difference it fixes is a write-through that was missed.
export async function syncEventHats(now = new Date()) {
  const results: { event: string; set: number; removed: number }[] = [];
  if (!(await isEventPointsEnabled())) return results;
  for (const eventDef of await hatSyncEvents(now)) {
    // One event failing (an unreadable flag throws) must not stop the others' hats syncing.
    try {
      results.push(await syncOneEvent(eventDef, now));
    } catch (error) {
      void logSyncError('syncEventHats', error, { event: eventDef.name });
    }
  }
  return results;
}

async function syncOneEvent(eventDef: ScoredEvent, now: Date) {
  const { scoring } = eventDef;
  const keys = eventPointKeys(eventDef.name);

  // Outside a scoring window nothing earns, so the desired map is empty and every hat comes off.
  const phase = await getEventScoringPhase(eventDef, now);
  const desired = phase
    ? await desiredEventHats(
        { name: eventDef.name, entityTypes: scoredEntityTypes(scoring) },
        phase.fliptKey
      )
    : new Map<string, string>();

  const current = (await sysRedis.hGetAll(keys.hats)) ?? {};
  const changes = diffHats(current, desired);
  await writeHatChanges(keys, changes);
  if (changes.set.length || changes.remove.length)
    void logToAxiom({
      type: 'warning',
      name: 'event-points',
      fn: 'reconcileEventHats',
      event: eventDef.name,
      setCount: changes.set.length,
      removedCount: changes.remove.length,
      set: changes.set.slice(0, LOGGED_KEYS_MAX).map(([key]) => key),
      removed: changes.remove.slice(0, LOGGED_KEYS_MAX),
    }).catch(() => undefined);

  for (const [type, rule] of Object.entries(scoring.types))
    if (rule) await sysRedis.hSetNX(keys.weights, type, String(rule.weight));

  return { event: eventDef.name, set: changes.set.length, removed: changes.remove.length };
}

// Brings one owner's hats in the hat map up to date, right after something changed them: an equip,
// move or unequip (`touched` names the content it left), or a change to the owner's standing. Never
// throws: a failure only delays the hat until the hourly reconcile.
export async function syncOwnerEventHats(
  ownerId: number,
  touched: HatEntity[] = [],
  now = new Date()
) {
  try {
    if (!(await isEventPointsEnabled())) return;
    for (const eventDef of await hatSyncEvents(now)) {
      try {
        await syncOwnerOneEvent(eventDef, ownerId, touched, now);
      } catch (error) {
        void logSyncError('syncOwnerEventHats', error, { event: eventDef.name, ownerId });
      }
    }
  } catch (error) {
    void logSyncError('syncOwnerEventHats', error, { ownerId });
  }
}

async function syncOwnerOneEvent(
  eventDef: ScoredEvent,
  ownerId: number,
  touched: HatEntity[],
  now: Date
) {
  const keys = eventPointKeys(eventDef.name);
  const entityTypes = scoredEntityTypes(eventDef.scoring);
  const phase = await getEventScoringPhase(eventDef, now);
  // From the primary: this runs right after the write it follows, which a replica may not have yet.
  const desired = phase
    ? await desiredEventHats({ name: eventDef.name, entityTypes }, phase.fliptKey, {
        ownerId,
        db: dbWrite,
      })
    : new Map<string, string>();
  // Where the owner's hats are, eligible or not, so a hat that stopped earning comes off.
  const open = await dbWrite.$queryRaw<HatEntity[]>`
    SELECT "entityType", "entityId" FROM "EventCosmeticPlacement"
    WHERE event = ${eventDef.name} AND "userId" = ${ownerId} AND "endedAt" IS NULL
  `;
  const candidates = [
    ...new Set([
      ...desired.keys(),
      ...[...open, ...touched].map((e) =>
        entityKey(e.entityType as EventPointEntityType, e.entityId)
      ),
    ]),
  ];
  if (!candidates.length) return;

  const values = await sysRedis.hmGet(keys.hats, candidates);
  // Another owner's hat on a touched entity is not this owner's to take off; the reconcile decides it.
  const current: Record<string, string> = {};
  candidates.forEach((key, i) => {
    const value = values[i];
    if (value && (desired.has(key) || decodeHat(value)?.ownerId === ownerId)) current[key] = value;
  });
  await writeHatChanges(keys, diffHats(current, desired));
}

// The owners of several placements that just changed together, e.g. a revoke across many holders.
export async function syncOwnersEventHats(placements: (HatEntity & { userId: number })[]) {
  const byOwner = new Map<number, HatEntity[]>();
  for (const { userId, ...entity } of placements)
    byOwner.set(userId, [...(byOwner.get(userId) ?? []), entity]);
  for (const [ownerId, touched] of byOwner) await syncOwnerEventHats(ownerId, touched);
}
