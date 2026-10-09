import type { EventScoring } from '~/server/events/base.event';
import { loadEvents } from '~/server/events/load-events';
import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { logToAxiom } from '~/server/logging/client';
import { sysRedis } from '~/server/redis/client';
import {
  decodeHat,
  entityKey,
  eventPointKeys,
  eventPointSeason,
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
  logError: (message: string, data: Record<string, unknown>) => void;
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
  let loading: Promise<void> | undefined;

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
    const hats = new Map(prev.hats);
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
    const stale = deps.now().getTime() - loadedAt >= STATE_REFRESH_MS;
    if (stale && !loading) {
      loading = refresh()
        .catch((error) => deps.logError('event points: state refresh failed', { error }))
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
    const [added] = await Promise.all([
      deps.redis.sAdd(seenKey, String(action.actorId)),
      rule.once === 'day'
        ? deps.redis.expire(seenKey, 2 * DAY_S)
        : deps.redis.expireAt(seenKey, eventExpiry(def)),
    ]);
    if (!added) return undefined;

    const weight = event.weights[action.type] ?? 0;
    if (weight > 0) {
      const capKey = keys.cap(day, hat.ownerId);
      const [totalAfter] = await Promise.all([
        deps.redis.hIncrBy(capKey, String(action.actorId), weight),
        deps.redis.expire(capKey, 2 * DAY_S),
      ]);
      const grant = cappedGrant(weight, Number(totalAfter), def.scoring.capPerActorPerOwnerPerDay);
      if (grant > 0) {
        const bucket = liveBucket(time);
        const field = hatField(hat);
        await Promise.all([
          deps.redis.hIncrBy(keys.live(bucket, 'hat'), field, grant),
          deps.redis.hIncrBy(keys.live(bucket, 'team'), hat.team, grant),
          deps.redis.hIncrBy(keys.live(bucket, 'owner'), String(hat.ownerId), grant),
          deps.redis.expire(keys.live(bucket, 'hat'), LIVE_TTL_S),
          deps.redis.expire(keys.live(bucket, 'team'), LIVE_TTL_S),
          deps.redis.expire(keys.live(bucket, 'owner'), LIVE_TTL_S),
          deps.redis.sAdd(eventPointKeys(def.name).changed, field),
        ]);
      }
    }
    // Every first is a fact, whether or not the cap let it score: if an earlier action from the same
    // person is later removed, the referee lets this one count instead.
    return ledgerRow(def.name, action, 'add', hat, time);
  }

  async function awardEventPoints(actions: EventPointAction[]) {
    if (!actions.length) return;
    try {
      await ensureFresh();
      if (!loaded.length) return;
      const rows = await Promise.all(
        loaded.flatMap((event) =>
          actions.map((action) => awardOne(event, action, action.time ?? deps.now()))
        )
      );
      const ledger = rows.filter((r): r is EventPointLedgerRow => !!r);
      if (ledger.length) await deps.insertLedger(ledger);
    } catch (error) {
      deps.logError('event points: award failed', { error, count: actions.length });
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
            // Only someone who earned on this entity this season has anything to net out, so every
            // other un-react or delete on the site writes nothing. Removing them from `seen` also lets
            // a later re-add count as a first again. Live totals keep the removed points until the
            // referee nets them out.
            const keys = eventSeasonKeys(
              event.def.name,
              eventPointSeason(event.def.startDate, time)
            );
            const removed = await deps.redis.sRem(
              keys.seen(removal.type, removal.entityType, removal.entityId),
              String(removal.actorId)
            );
            if (removed) rows.push(ledgerRow(event.def.name, removal, 'remove', hat, time));
          })
        )
      );
      if (rows.length) await deps.insertLedger(rows);
    } catch (error) {
      deps.logError('event points: removal failed', { error, count: removals.length });
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

async function loadScoredEvents(now: Date): Promise<ScoredEventDef[]> {
  const events = await loadEvents();
  const scored: ScoredEventDef[] = [];
  for (const e of events) {
    if (!e.scoring) continue;
    const from = e.previewFrom ?? e.startDate;
    if (now < from || now.getTime() > e.endDate.getTime() + e.scoring.finalizeAfterMs) continue;
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
    logError: (message, data) =>
      void logToAxiom({ type: 'error', name: 'event-points', message, ...data }).catch(
        () => undefined
      ),
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
