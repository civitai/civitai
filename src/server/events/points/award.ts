import type { EventScoring } from '~/server/events/base.event';
import { loadEvents } from '~/server/events/load-events';
import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import {
  decodeHat,
  entityKey,
  eventPointKeys,
  eventPointSeason,
  eventPointsWindow,
  eventSeasonKeys,
  hatField,
  liveBucket,
  utcDay,
} from '~/server/events/points/keys';
import type {
  EventHat,
  EventPointAction,
  EventPointEntityType,
  EventPointRemoval,
  EventPointType,
} from '~/server/events/points/types';

const DAY_S = 24 * 60 * 60;
// How often an app server re-reads which entities wear a hat. A hat placed or moved starts earning
// within this long plus the hat sync job's minute.
const STATE_REFRESH_MS = 30 * 1000;
// After a failed refresh, wait this long before trying again, so a persistent failure is not retried
// by every request on the hot path.
const REFRESH_RETRY_MS = 10 * 1000;
// Live buckets outlive the referee's hourly cut by a wide margin.
const LIVE_TTL_S = 3 * 60 * 60;

export const EVENT_POINTS_LEDGER_TABLE = 'event_point_events';

// Points a first action adds, given the person's running total for this creator today AFTER adding
// its full weight. The cap applies to what was actually given, so concurrent actions from one person
// each take exactly the part of the cap that was left when their increment landed.
export function cappedGrant(weight: number, totalAfter: number, cap: number) {
  return Math.max(0, Math.min(cap, totalAfter) - Math.min(cap, totalAfter - weight));
}

type ScoredEventDef = { name: string; startDate: Date; endDate: Date; scoring: EventScoring };

type LoadedEvent = {
  def: ScoredEventDef;
  hats: Map<string, EventHat>;
  weights: Partial<Record<EventPointType, number>>;
  // Last hatsLog entry applied to `hats`.
  cursor: string;
};

export type EventPointsRedis = Pick<
  typeof sysRedis,
  'hGetAll' | 'sAdd' | 'sRem' | 'expire' | 'expireAt' | 'hIncrBy' | 'xRange' | 'xRevRange'
>;

export type EventPointsFailure = 'redis' | 'ledger';

// Stream ids are `ms-seq`; compare numerically, part by part.
export function streamIdBefore(a: string, b: string) {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return am < bm || (am === bm && as < bs);
}

export type EventPointsDeps = {
  redis: EventPointsRedis;
  insertLedger: (rows: EventPointLedgerRow[]) => Promise<void>;
  // Scored events whose points are live now: from preview start to the end of finalization.
  loadScoredEvents: (now: Date) => Promise<ScoredEventDef[]>;
  now: () => Date;
  logError: (kind: EventPointsFailure, fn: string, error: unknown, extra?: object) => void;
};

export type EventPointLedgerRow = {
  event: string;
  time: string;
  type: EventPointType;
  op: 'add' | 'remove';
  actorId: number;
  entityType: EventPointEntityType;
  entityId: number;
  ownerId: number;
  cosmeticId: number;
  claimKey: string;
  team: string;
  sourceId: string;
};

const ledgerRow = (
  event: string,
  action: EventPointAction | EventPointRemoval,
  op: 'add' | 'remove',
  hat: EventHat | undefined,
  time: Date
): EventPointLedgerRow => ({
  event,
  time: formatClickhouseDateTime64(time),
  type: action.type,
  op,
  actorId: action.actorId,
  entityType: action.entityType,
  entityId: action.entityId,
  ownerId: hat?.ownerId ?? 0,
  cosmeticId: hat?.cosmeticId ?? 0,
  claimKey: hat?.claimKey ?? '',
  team: hat?.team ?? '',
  sourceId: action.sourceId ?? '',
});

export function createEventPointsEngine(deps: EventPointsDeps) {
  let loaded: LoadedEvent[] = [];
  let loadedAt = 0;
  let attemptedAt = 0;
  let loading: Promise<void> | undefined;
  // Live bucket keys this server already gave a TTL, so each gets one EXPIRE, not one per award.
  const bucketTtlSet = new Set<string>();

  // Live weights win over the config, so a weight can change without a deploy.
  async function loadWeights(def: ScoredEventDef) {
    const raw = await deps.redis.hGetAll(eventPointKeys(def.name).weights);
    const weights: LoadedEvent['weights'] = {};
    for (const [type, rule] of Object.entries(def.scoring.types)) {
      const live = raw?.[type] != null ? Number(raw[type]) : NaN;
      weights[type as EventPointType] = Number.isFinite(live) ? live : rule.weight;
    }
    return weights;
  }

  // The whole hat map, once per server. The cursor is read FIRST: changes logged while the hash is
  // being read are replayed on the next follow, and replaying a change is harmless.
  async function loadHats(event: string) {
    const keys = eventPointKeys(event);
    const [last] = await deps.redis.xRevRange(keys.hatsLog, '+', '-', { COUNT: 1 });
    const raw = await deps.redis.hGetAll(keys.hats);
    const hats = new Map<string, EventHat>();
    for (const [key, value] of Object.entries(raw ?? {})) {
      const hat = decodeHat(value);
      if (hat) hats.set(key, hat);
    }
    return { hats, cursor: last?.id ?? '0-0' };
  }

  // Applies the changes logged since the cursor. If the log was trimmed past the cursor, some changes
  // are gone, so it reloads instead.
  async function followHats(event: string, prev: LoadedEvent) {
    const keys = eventPointKeys(event);
    const [first] = await deps.redis.xRange(keys.hatsLog, '-', '+', { COUNT: 1 });
    if (first && prev.cursor !== '0-0' && streamIdBefore(prev.cursor, first.id))
      return loadHats(event);
    if (first && prev.cursor === '0-0') return loadHats(event);
    const entries = await deps.redis.xRange(keys.hatsLog, `(${prev.cursor}`, '+');
    if (!entries.length) return { hats: prev.hats, cursor: prev.cursor };
    // In place: reads are synchronous, so nothing sees a half-applied batch.
    const hats = prev.hats;
    for (const { message } of entries) {
      const hat = message.v ? decodeHat(message.v) : undefined;
      if (hat) hats.set(message.k, hat);
      else hats.delete(message.k);
    }
    return { hats, cursor: entries[entries.length - 1].id };
  }

  async function refresh() {
    const now = deps.now();
    const defs = await deps.loadScoredEvents(now);
    const next: LoadedEvent[] = [];
    for (const def of defs) {
      const prev = loaded.find((l) => l.def.name === def.name);
      const [weights, hatState] = await Promise.all([
        loadWeights(def),
        prev ? followHats(def.name, prev) : loadHats(def.name),
      ]);
      next.push({ def, weights, ...hatState });
    }
    loaded = next;
    loadedAt = now.getTime();
  }

  // Never blocks a caller on a refresh once something is loaded: a stale hat map for one refresh
  // interval is fine, a slow tracking request is not.
  function ensureFresh() {
    const now = deps.now().getTime();
    const stale = now - loadedAt >= STATE_REFRESH_MS && now - attemptedAt >= REFRESH_RETRY_MS;
    if (stale && !loading) {
      attemptedAt = now;
      loading = refresh()
        .catch((error) => deps.logError('redis', 'eventPoints.refresh', error))
        .finally(() => (loading = undefined));
    }
    return loadedAt === 0 ? loading : undefined;
  }

  function isEligibleActor(def: ScoredEventDef, action: EventPointAction) {
    const { actor } = action;
    if (!actor) return true;
    if (actor.bannedAt) return false;
    const cutoff = def.startDate.getTime() - def.scoring.newAccountDays * DAY_S * 1000;
    return !actor.createdAt || actor.createdAt.getTime() < cutoff;
  }

  async function awardOne(event: LoadedEvent, action: EventPointAction, time: Date) {
    const { def } = event;
    // Hats stay on content after the event; only actions inside it count.
    if (time >= def.endDate) return undefined;
    const rule = def.scoring.types[action.type];
    if (!rule || !rule.entities.includes(action.entityType)) return undefined;
    const hat = event.hats.get(entityKey(action.entityType, action.entityId));
    if (!hat || hat.ownerId === action.actorId) return undefined;
    if (!isEligibleActor(def, action)) return undefined;

    const keys = eventSeasonKeys(def.name, eventPointSeason(def.startDate, time));
    const day = utcDay(time);
    const seenKey = keys.seen(
      action.type,
      action.entityType,
      action.entityId,
      rule.once === 'day' ? day : undefined
    );
    const actor = String(action.actorId);
    if (!(await deps.redis.sAdd(seenKey, actor))) return undefined;
    // TTLs are set once, when the key is created. Day-scoped keys only matter for their UTC day.
    await deps.redis.expireAt(seenKey, rule.once === 'day' ? dayExpiry(time) : eventExpiry(def));

    const weight = event.weights[action.type] ?? 0;
    if (weight > 0) {
      const capKey = keys.cap(day, hat.ownerId);
      const totalAfter = Number(await deps.redis.hIncrBy(capKey, actor, weight));
      if (totalAfter === weight) await deps.redis.expireAt(capKey, dayExpiry(time));
      const grant = cappedGrant(weight, totalAfter, def.scoring.capPerActorPerOwnerPerDay);
      if (grant > 0) {
        const bucket = liveBucket(time);
        const field = hatField(hat);
        const live = [
          [keys.live(bucket, 'hat'), field],
          [keys.live(bucket, 'team'), hat.team],
          [keys.live(bucket, 'owner'), String(hat.ownerId)],
        ] as const;
        await Promise.all([
          ...live.map(([key, f]) => deps.redis.hIncrBy(key, f, grant)),
          deps.redis.sAdd(eventPointKeys(def.name).changed, field),
        ]);
        for (const [key] of live) {
          if (bucketTtlSet.has(key)) continue;
          if (bucketTtlSet.size >= 1000) bucketTtlSet.clear();
          bucketTtlSet.add(key);
          await deps.redis.expire(key, LIVE_TTL_S);
        }
      }
    }
    // Every first is a fact, whether or not the cap let it score: if an earlier action from the same
    // person is later removed, the referee lets this one count instead.
    return { row: ledgerRow(def.name, action, 'add', hat, time), seenKey, actor };
  }

  async function awardEventPoints(actions: EventPointAction[]) {
    if (!actions.length) return;
    try {
      await ensureFresh();
      if (!loaded.length) return;
      // Settled one by one: a Redis error on one action must not drop the others' ledger rows.
      const results = await Promise.allSettled(
        loaded.flatMap((event) =>
          actions.map((action) => awardOne(event, action, action.time ?? deps.now()))
        )
      );
      const firsts: NonNullable<Awaited<ReturnType<typeof awardOne>>>[] = [];
      for (const result of results) {
        if (result.status === 'rejected') deps.logError('redis', 'eventPoints.award', result.reason);
        else if (result.value) firsts.push(result.value);
      }
      if (!firsts.length) return;
      try {
        await deps.insertLedger(firsts.map((f) => f.row));
      } catch (error) {
        // The referee scores from the ledger alone. A first it never received would stay marked
        // seen, so the same action could never earn again: take the marks back so the next one
        // counts. The live points stay until the referee corrects them.
        deps.logError('ledger', 'eventPoints.insertLedger', error, { rows: firsts.length });
        await Promise.allSettled(firsts.map((f) => deps.redis.sRem(f.seenKey, f.actor)));
      }
    } catch (error) {
      deps.logError('redis', 'eventPoints.award', error, { count: actions.length });
    }
  }

  async function removeEventPoints(removals: EventPointRemoval[]) {
    if (!removals.length) return;
    try {
      await ensureFresh();
      if (!loaded.length) return;
      const rows: EventPointLedgerRow[] = [];
      await Promise.all(
        loaded.flatMap((event) =>
          removals.map(async (removal) => {
            const rule = event.def.scoring.types[removal.type];
            if (!rule || !rule.entities.includes(removal.entityType)) return;
            // Daily types (views) are never taken back.
            if (rule.once !== 'event') return;
            const hat = event.hats.get(entityKey(removal.entityType, removal.entityId));
            const time = removal.time ?? deps.now();
            // Only someone who earned on this entity this season, or anyone on a hatted entity (in
            // case Redis lost the mark), has anything to net out, so un-reacts elsewhere on the site
            // write nothing. Removing them from `seen` lets a later re-add count as a first again.
            // Live totals keep the removed points until the referee nets them out.
            const keys = eventSeasonKeys(
              event.def.name,
              eventPointSeason(event.def.startDate, time)
            );
            const removed = await deps.redis.sRem(
              keys.seen(removal.type, removal.entityType, removal.entityId),
              String(removal.actorId)
            );
            if (removed || hat) rows.push(ledgerRow(event.def.name, removal, 'remove', hat, time));
          })
        )
      );
      if (rows.length) await deps.insertLedger(rows);
    } catch (error) {
      deps.logError('ledger', 'eventPoints.remove', error, { count: removals.length });
    }
  }

  // Synchronous, for the view hot path: true when any live event has a hat on this entity. False
  // until the first refresh completes, so the first requests after a deploy skip, not wait.
  function isHattedEntity(entityType: string, entityId: number) {
    void ensureFresh();
    const key = `${entityType}:${entityId}`;
    return loaded.some((event) => event.hats.has(key));
  }

  return { awardEventPoints, removeEventPoints, isHattedEntity, refresh };
}

// Event-scoped dedupe keys live until two days after scoring finalizes.
const eventExpiry = (def: ScoredEventDef) =>
  Math.ceil((def.endDate.getTime() + def.scoring.finalizeAfterMs) / 1000) + 2 * DAY_S;
// Day-scoped keys (view dedupe, the daily cap) live until an hour after their UTC day ends.
const dayExpiry = (time: Date) =>
  Math.ceil(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate() + 1) / 1000) +
  60 * 60;

async function loadScoredEvents(now: Date): Promise<ScoredEventDef[]> {
  const events = await loadEvents();
  const scored: ScoredEventDef[] = [];
  for (const e of events) {
    if (!e.scoring) continue;
    const window = eventPointsWindow({ ...e, scoring: e.scoring });
    if (now < window.from || now > window.to) continue;
    scored.push({ name: e.name, startDate: e.startDate, endDate: e.endDate, scoring: e.scoring });
  }
  return scored;
}

let engine: ReturnType<typeof createEventPointsEngine> | undefined;
function getEngine() {
  engine ??= createEventPointsEngine({
    redis: sysRedis,
    insertLedger: async (rows) => {
      if (!clickhouse) return;
      await clickhouse.insert({
        table: EVENT_POINTS_LEDGER_TABLE,
        values: rows,
        format: 'JSONEachRow',
      });
    },
    loadScoredEvents,
    now: () => new Date(),
    logError: (kind, fn, error, extra) => {
      if (kind === 'redis') return logSysRedisFailOpen('write-degraded', fn, error, { ...extra });
      void logToAxiom({ type: 'error', name: 'event-points', fn, error, ...extra }).catch(
        () => undefined
      );
    },
  });
  return engine;
}

// Records actions that may earn event points. Never throws and never needs awaiting for
// correctness; await it only to keep a test deterministic.
export const awardEventPoints = (actions: EventPointAction[]) =>
  getEngine().awardEventPoints(actions);
export const removeEventPoints = (removals: EventPointRemoval[]) =>
  getEngine().removeEventPoints(removals);
export const isHattedEntity = (entityType: string, entityId: number) =>
  getEngine().isHattedEntity(entityType, entityId);
