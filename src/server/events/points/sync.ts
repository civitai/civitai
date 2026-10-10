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
  hatSyncKeys,
} from '~/server/events/points/keys';
import type { EventHat, EventPointEntityType } from '~/server/events/points/types';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';

// Enough log for an app server that missed a few refreshes; one further behind reloads the hash.
const HATS_LOG_MAX = 50_000;
// How many changed keys one reconcile log line names; the counts are always complete.
const LOGGED_KEYS_MAX = 50;
// One owner's write-through holds its lock at most this long, so a crashed holder blocks nobody for
// longer than that.
const HAT_SYNC_LOCK_MS = 10_000;
// Passes one holder makes for callers that arrived while it ran, before it leaves the rest to the
// reconcile.
export const HAT_SYNC_MAX_PASSES = 5;
// Past this many owners in one batch, one full reconcile is cheaper than a write-through per owner.
const OWNER_BATCH_MAX = 200;

type OpenPlacement = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  team: string;
  entityType: EventPointEntityType;
  entityId: number;
  eligible: boolean;
};

type ScoredEvent = GatedEvent & { endDate: Date; scoring: EventScoring };
type HatEntity = { entityType: string; entityId: number };

// The open placements of an event, each marked whether it may earn: on its owner's own content, an
// entity type the event scores, its owner not banned, deleted or excluded from leaderboards. Oldest
// first. `ownerId` narrows it to one owner's, which is the whole answer for their content: only an
// entity's owner can score on it.
async function openEventPlacements(
  event: { name: string; entityTypes: readonly EventPointEntityType[] },
  { ownerId, db = dbRead }: { ownerId?: number; db?: typeof dbRead | typeof dbWrite } = {}
) {
  return db.$queryRaw<OpenPlacement[]>`
    SELECT p."userId", p."cosmeticId", p."claimKey", p.team, p."entityType", p."entityId",
      COALESCE(
        p."entityOwnerId" = p."userId"
          AND p."entityType"::text = ANY(${[...event.entityTypes]}::text[])
          AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL AND NOT u."excludeFromLeaderboards",
        false
      ) AS eligible
    FROM "EventCosmeticPlacement" p
    JOIN "User" u ON u.id = p."userId"
    WHERE p.event = ${event.name}
      AND p."endedAt" IS NULL
      ${ownerId ? Prisma.sql`AND p."userId" = ${ownerId}` : Prisma.empty}
    ORDER BY p."startedAt", p.id
  `;
}

// The hats that may earn points right now, by entity key: the eligible placements, during the
// preview only those of owners the flag is on for. One entity wearing two event hats scores for the
// one placed first.
async function pickEventHats(rows: OpenPlacement[], fliptKey: string | undefined) {
  const eligible = rows.filter((r) => r.eligible);
  const audience = fliptKey
    ? await flagAudienceAmong(fliptKey, [...new Set(eligible.map((r) => r.userId))])
    : undefined;
  const hats = new Map<string, string>();
  for (const r of eligible) {
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

export async function desiredEventHats(
  event: { name: string; entityTypes: readonly EventPointEntityType[] },
  fliptKey: string | undefined,
  options: { ownerId?: number; db?: typeof dbRead | typeof dbWrite } = {}
) {
  return pickEventHats(await openEventPlacements(event, options), fliptKey);
}

// What to write so `current` becomes `desired`: changed or new entries, and keys to remove.
export function diffHats(current: Record<string, string>, desired: Map<string, string>) {
  const set: [string, string][] = [];
  const remove: string[] = [];
  for (const [key, value] of desired) if (current[key] !== value) set.push([key, value]);
  for (const key of Object.keys(current)) if (!desired.has(key)) remove.push(key);
  return { set, remove };
}

// Hash first, then the log entry. Followers re-read the hash for every key the log names, so with
// several writers racing, the last log entry for a key always comes after its last hash write.
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

// Scored events whose hat map may still change: until scoring finalizes. Unlike the engine's
// loadScoredEvents it has no lower bound, so hats come off before a preview too.
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
// referee runs it too before settling. Every difference it finds is a write-through that was missed.
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
  if (changes.set.length || changes.remove.length) {
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
    await applyReconcile(keys, changes, current, desired, now);
  }

  for (const [type, rule] of Object.entries(scoring.types))
    if (rule) await sysRedis.hSetNX(keys.weights, type, String(rule.weight));

  return { event: eventDef.name, set: changes.set.length, removed: changes.remove.length };
}

// The full scan reads the replica and a write-through can land while it runs, so a difference it
// finds is re-derived for that owner on the primary, under the owner's lock, rather than written as
// read. Only a key with no readable owner, or a batch too big to go owner by owner, is written as is.
async function applyReconcile(
  keys: ReturnType<typeof eventPointKeys>,
  changes: ReturnType<typeof diffHats>,
  current: Record<string, string>,
  desired: Map<string, string>,
  now: Date
) {
  const byOwner = new Map<number, string[]>();
  const unowned: string[] = [];
  for (const key of [...changes.set.map(([key]) => key), ...changes.remove]) {
    const ownerId = decodeHat(desired.get(key) ?? current[key] ?? '')?.ownerId;
    if (ownerId) byOwner.set(ownerId, [...(byOwner.get(ownerId) ?? []), key]);
    else unowned.push(key);
  }
  if (byOwner.size > OWNER_BATCH_MAX) return writeHatChanges(keys, changes);
  if (unowned.length) await writeHatChanges(keys, { set: [], remove: unowned });
  for (const [ownerId, touched] of byOwner) await runOwnerHatSync(ownerId, touched, now);
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
    await runOwnerHatSync(
      ownerId,
      touched.map((e) => entityKey(e.entityType as EventPointEntityType, e.entityId)),
      now
    );
  } catch (error) {
    void logSyncError('syncOwnerEventHats', error, { ownerId });
  }
}

const PENDING_ALL = '*';

// One owner's passes run one at a time. Two unserialized passes could land in either order, and the
// older read landing last would leave a hat on that came off. A caller that finds a pass running
// leaves its content in the pending set and returns; the holder runs again until nothing is pending,
// so the last pass always reads after the last write. If Redis cannot take the lock, the pass runs
// anyway: a skipped write-through costs more than an unserialized one.
async function runOwnerHatSync(ownerId: number, touched: string[], now = new Date()) {
  const lock = hatSyncKeys(ownerId);
  let next = touched;
  for (let pass = 0; pass < HAT_SYNC_MAX_PASSES; pass++) {
    try {
      const held = await sysRedis.set(lock.lock, '1', { NX: true, PX: HAT_SYNC_LOCK_MS });
      if (!held) {
        await sysRedis.sAdd(lock.pending, [PENDING_ALL, ...next]);
        await sysRedis.pExpire(lock.pending, HAT_SYNC_LOCK_MS);
        // The holder may have let go between our SET and SADD, and then nobody would read the set.
        if (await sysRedis.exists(lock.lock)) return;
        continue;
      }
    } catch (error) {
      void logSyncError('runOwnerHatSync.lock', error, { ownerId });
      return syncOwnerPass(ownerId, next, now);
    }
    try {
      next = [...new Set([...next, ...entityKeysOf(await popPending(lock.pending))])];
      await syncOwnerPass(ownerId, next, now);
    } finally {
      await sysRedis.del(lock.lock).catch(() => undefined);
    }
    const pending = await popPending(lock.pending);
    if (!pending.length) return;
    next = entityKeysOf(pending);
  }
  void logToAxiom({
    type: 'warning',
    name: 'event-points',
    fn: 'runOwnerHatSync',
    message: 'gave up after max passes; the reconcile finishes it',
    ownerId,
  }).catch(() => undefined);
}

const entityKeysOf = (pending: string[]) => pending.filter((key) => key !== PENDING_ALL);

async function popPending(key: string) {
  const members = await sysRedis.sPop(key, 10_000);
  return (Array.isArray(members) ? members : members ? [members] : []).filter(
    (member): member is string => typeof member === 'string'
  );
}

async function syncOwnerPass(ownerId: number, touched: string[], now: Date) {
  for (const eventDef of await hatSyncEvents(now)) {
    try {
      await syncOwnerOneEvent(eventDef, ownerId, touched, now);
    } catch (error) {
      void logSyncError('syncOwnerEventHats', error, { event: eventDef.name, ownerId });
    }
  }
}

async function syncOwnerOneEvent(
  eventDef: ScoredEvent,
  ownerId: number,
  touched: string[],
  now: Date
) {
  const keys = eventPointKeys(eventDef.name);
  const phase = await getEventScoringPhase(eventDef, now);
  // From the primary: this runs right after the write it follows, which a replica may not have yet.
  const rows = await openEventPlacements(
    { name: eventDef.name, entityTypes: scoredEntityTypes(eventDef.scoring) },
    { ownerId, db: dbWrite }
  );
  const desired = phase ? await pickEventHats(rows, phase.fliptKey) : new Map<string, string>();
  // Every open placement, eligible or not, so a hat that stopped earning comes off.
  const candidates = [
    ...new Set([...rows.map((r) => entityKey(r.entityType, r.entityId)), ...touched]),
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
// Past OWNER_BATCH_MAX owners it runs one full reconcile instead.
export async function syncOwnersEventHats(placements: (HatEntity & { userId: number })[]) {
  const byOwner = new Map<number, HatEntity[]>();
  for (const { userId, ...entity } of placements)
    byOwner.set(userId, [...(byOwner.get(userId) ?? []), entity]);
  if (byOwner.size > OWNER_BATCH_MAX) {
    await syncEventHats().catch((error) =>
      logSyncError('syncOwnersEventHats', error, { owners: byOwner.size })
    );
    return;
  }
  for (const [ownerId, touched] of byOwner) await syncOwnerEventHats(ownerId, touched);
}
