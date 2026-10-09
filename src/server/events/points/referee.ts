import { chunk } from 'lodash-es';
import type { EventScoring } from '~/server/events/base.event';
import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  eventPointKeys,
  eventSeasonKeys,
  hatField,
  LIVE_BUCKET_MS,
  type EventPointSeason,
  type TotalScope,
} from '~/server/events/points/keys';
import {
  eventPointsRefereeSql,
  eventPointsRefereeUsersSql,
} from '~/server/events/points/referee.sql';
import { sysRedis } from '~/server/redis/client';

const DAY_MS = 24 * 60 * 60 * 1000;
// Settle only up to a bucket boundary this far back, so ledger rows still in ClickHouse's async
// insert buffer land before their bucket is settled.
const SETTLE_LAG_MS = 10 * 60 * 1000;
// The hour (UTC) whose run recomputes the whole season, picking up late removals and bans on days
// the hourly runs treat as final.
const FULL_RECOMPUTE_HOUR = 3;

export type RefereeEvent = {
  name: string;
  startDate: Date;
  endDate: Date;
  previewFrom?: Date;
  scoring: EventScoring;
};

export type RefereeRow = {
  day: string;
  userId: number;
  cosmeticId: number;
  claimKey: string;
  team: string;
  points: number;
  views: number;
  reactions: number;
  comments: number;
  stickers: number;
  remixes: number;
  modelLikes: number;
};

const startOfUtcDay = (time: Date) =>
  new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()));

// The season's window, the cut-off this run settles to (a bucket boundary at least SETTLE_LAG_MS in
// the past, never past the season's end), and the first day it recomputes: the day before the cut's
// day, or the whole season on the nightly full run.
export function refereeWindow(event: RefereeEvent, season: EventPointSeason, now: Date) {
  const start = season === 'preview' ? event.previewFrom ?? event.startDate : event.startDate;
  const end = season === 'preview' ? event.startDate : event.endDate;
  const settled = Math.floor((now.getTime() - SETTLE_LAG_MS) / LIVE_BUCKET_MS) * LIVE_BUCKET_MS;
  const cut = new Date(Math.min(settled, end.getTime()));
  const full = now.getUTCHours() === FULL_RECOMPUTE_HOUR;
  const dayBefore = new Date(startOfUtcDay(cut).getTime() - DAY_MS);
  const recomputeFrom = full || dayBefore < start ? start : dayBefore;
  return { start, cut, recomputeFrom };
}

// Totals per hat, team and owner: the final days from the snapshot plus the recomputed rows.
export function refereeTotals(
  rows: Pick<RefereeRow, 'userId' | 'cosmeticId' | 'claimKey' | 'team' | 'points'>[]
) {
  const totals: Record<TotalScope, Map<string, number>> = {
    hat: new Map(),
    team: new Map(),
    owner: new Map(),
  };
  const add = (scope: TotalScope, key: string, points: number) =>
    totals[scope].set(key, (totals[scope].get(key) ?? 0) + points);
  for (const r of rows) {
    if (!r.points) continue;
    add(
      'hat',
      hatField({ ownerId: r.userId, cosmeticId: r.cosmeticId, claimKey: r.claimKey }),
      r.points
    );
    add('team', r.team, r.points);
    add('owner', String(r.userId), r.points);
  }
  return totals;
}

// Hats whose shown total moves when the base is replaced: shown before = old base plus the live
// buckets this run settles; shown after = new base.
export function changedHats(
  oldBase: Record<string, string>,
  settledLive: Record<string, string>[],
  newBase: Map<string, number>
) {
  const before = new Map<string, number>();
  for (const source of [oldBase, ...settledLive])
    for (const [field, value] of Object.entries(source))
      before.set(field, (before.get(field) ?? 0) + (Number(value) || 0));
  const changed: string[] = [];
  for (const field of new Set([...before.keys(), ...newBase.keys()]))
    if ((before.get(field) ?? 0) !== (newBase.get(field) ?? 0)) changed.push(field);
  return changed;
}

type Window = ReturnType<typeof refereeWindow>;

export function refereeQueryParams(
  event: RefereeEvent,
  window: Window,
  liveWeights: Record<string, string> | undefined,
  restricted: { actors: number[]; owners: number[] }
) {
  const types = Object.entries(event.scoring.types).filter(([, rule]) => !!rule);
  return {
    event: event.name,
    seasonStart: formatClickhouseDateTime64(window.start),
    recomputeFrom: formatClickhouseDateTime64(window.recomputeFrom),
    cut: formatClickhouseDateTime64(window.cut),
    cap: event.scoring.capPerActorPerOwnerPerDay,
    types: types.map(([type]) => type),
    // The live weights, so the referee and the live totals agree; the config fills any gap.
    weights: types.map(([type, rule]) => {
      const live = liveWeights?.[type] != null ? Number(liveWeights[type]) : NaN;
      return Number.isFinite(live) ? live : rule!.weight;
    }),
    dailyTypes: types.filter(([, rule]) => rule!.once === 'day').map(([type]) => type),
    restrictedActors: restricted.actors,
    restrictedOwners: restricted.owners,
  };
}

// Of the people the recomputed rows involve, those who must not earn or give points, from their
// accounts in Postgres: banned, deleted or excluded from leaderboards; actors also when registered
// inside the new-account window.
async function restrictedUsers(event: RefereeEvent, window: Window) {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const params = refereeQueryParams(event, window, undefined, { actors: [], owners: [] });
  const result = await clickhouse.query({
    query: eventPointsRefereeUsersSql,
    format: 'JSONEachRow',
    query_params: params,
  });
  const [users] = await result.json<{ actors: number[]; owners: number[] }>();
  const ids = [...new Set([...(users?.actors ?? []), ...(users?.owners ?? [])].map(Number))];
  const newAccountCutoff = new Date(
    event.startDate.getTime() - event.scoring.newAccountDays * DAY_MS
  );
  const actors = new Set<number>();
  const owners = new Set<number>();
  for (const part of chunk(ids, 10_000)) {
    const rows = await dbRead.$queryRaw<{ id: number; hidden: boolean }[]>`
      SELECT id,
        ("bannedAt" IS NOT NULL OR "deletedAt" IS NOT NULL OR "excludeFromLeaderboards") AS hidden
      FROM "User"
      WHERE id = ANY(${part}::int[])
        AND ("bannedAt" IS NOT NULL OR "deletedAt" IS NOT NULL OR "excludeFromLeaderboards"
          OR "createdAt" >= ${newAccountCutoff})
    `;
    for (const r of rows) {
      actors.add(r.id);
      if (r.hidden) owners.add(r.id);
    }
  }
  return { actors: [...actors], owners: [...owners] };
}

async function queryReferee(event: RefereeEvent, window: Window) {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const [weights, restricted] = await Promise.all([
    sysRedis.hGetAll(eventPointKeys(event.name).weights),
    restrictedUsers(event, window),
  ]);
  const result = await clickhouse.query({
    query: eventPointsRefereeSql,
    format: 'JSONEachRow',
    // A whole-season run on the nightly pass groups every first of the season; spill to disk rather
    // than fail on memory, and allow it the time.
    clickhouse_settings: {
      max_execution_time: 600,
      max_bytes_before_external_group_by: '8000000000',
      max_bytes_before_external_sort: '8000000000',
    },
    query_params: refereeQueryParams(event, window, weights, restricted),
  });
  return (await result.json<RefereeRow>()).map((r) => ({
    day: String(r.day),
    userId: Number(r.userId),
    cosmeticId: Number(r.cosmeticId),
    claimKey: String(r.claimKey),
    team: String(r.team),
    points: Number(r.points),
    views: Number(r.views),
    reactions: Number(r.reactions),
    comments: Number(r.comments),
    stickers: Number(r.stickers),
    remixes: Number(r.remixes),
    modelLikes: Number(r.modelLikes),
  }));
}

const isoDay = (time: Date) => time.toISOString().slice(0, 10);

// The durable record: one row per hat per day, which the standings, the winner and the per-hat
// counts read. Recomputing a day replaces it, so a rerun never double counts. Days before
// recomputeFrom are left as they are.
async function writeDailySnapshot(event: RefereeEvent, window: Window, rows: RefereeRow[]) {
  await dbWrite.$transaction([
    dbWrite.$executeRaw`
      DELETE FROM "EventCosmeticScoreDaily"
      WHERE event = ${event.name}
        AND day >= ${isoDay(window.recomputeFrom)}::date AND day <= ${isoDay(window.cut)}::date
    `,
    ...chunk(rows, 5000).map(
      (part) => dbWrite.$executeRaw`
        INSERT INTO "EventCosmeticScoreDaily"
          (event, day, "userId", "cosmeticId", "claimKey", team, impressions, "anonImpressions",
           reactions, comments, stickers, remixes, "modelLikes", points)
        SELECT ${event.name}, u.day, u."userId", u."cosmeticId", u."claimKey", u.team, u.views, 0,
          u.reactions, u.comments, u.stickers, u.remixes, u."modelLikes", u.points
        FROM unnest(
          ${part.map((r) => r.day)}::date[],
          ${part.map((r) => r.userId)}::int[],
          ${part.map((r) => r.cosmeticId)}::int[],
          ${part.map((r) => r.claimKey)}::text[],
          ${part.map((r) => r.team)}::text[],
          ${part.map((r) => r.views)}::int[],
          ${part.map((r) => r.reactions)}::int[],
          ${part.map((r) => r.comments)}::int[],
          ${part.map((r) => r.stickers)}::int[],
          ${part.map((r) => r.remixes)}::int[],
          ${part.map((r) => r.modelLikes)}::int[],
          ${part.map((r) => r.points)}::int[]
        ) AS u(day, "userId", "cosmeticId", "claimKey", team, views, reactions, comments, stickers,
               remixes, "modelLikes", points)
      `
    ),
  ]);
}

// Per-hat points on the days this run leaves final, from the snapshot.
async function finalDayTotals(event: RefereeEvent, window: Window) {
  if (window.recomputeFrom <= window.start) return [];
  return dbWrite.$queryRaw<
    { userId: number; cosmeticId: number; claimKey: string; team: string; points: number }[]
  >`
    SELECT "userId", "cosmeticId", "claimKey", min(team) AS team, sum(points)::int AS points
    FROM "EventCosmeticScoreDaily"
    WHERE event = ${event.name}
      AND day >= ${isoDay(window.start)}::date AND day < ${isoDay(window.recomputeFrom)}::date
    GROUP BY "userId", "cosmeticId", "claimKey"
  `;
}

export type RefereeRedis = Pick<
  typeof sysRedis,
  'get' | 'hGetAll' | 'del' | 'hSet' | 'multi' | 'sAdd'
>;

const TMP_SUFFIX = ':next';

// Replaces the live base with the referee's totals and moves the cut, in one MULTI, so a reader
// never sees the new base with the old cut (which would count the settled buckets twice). Hats whose
// shown total moved go into the changed set, so the signals ticker pushes the correction.
export async function resetLiveBase(
  redis: RefereeRedis,
  event: { name: string },
  season: EventPointSeason,
  cut: Date,
  totals: ReturnType<typeof refereeTotals>
) {
  const keys = eventSeasonKeys(event.name, season);
  const oldCutBucket = Number((await redis.get(keys.cut)) ?? 0);
  const newCutBucket = cut.getTime() / LIVE_BUCKET_MS;

  const oldHatBase = (await redis.hGetAll(keys.base('hat'))) ?? {};
  const settledKeys: ReturnType<typeof keys.live>[] = [];
  if (oldCutBucket)
    for (let b = oldCutBucket; b < newCutBucket; b++) settledKeys.push(keys.live(b, 'hat'));
  const settled = await Promise.all(
    settledKeys.map(async (key) => (await redis.hGetAll(key)) ?? {})
  );
  const changed = oldCutBucket
    ? changedHats(oldHatBase, settled, totals.hat)
    : [...totals.hat.keys()];

  const scopes: TotalScope[] = ['hat', 'team', 'owner'];
  for (const scope of scopes) {
    const tmp = `${keys.base(scope)}${TMP_SUFFIX}` as const;
    await redis.del(tmp);
    for (const part of chunk([...totals[scope].entries()], 1000))
      await redis.hSet(tmp, Object.fromEntries(part.map(([k, v]) => [k, String(v)])));
  }
  const multi = redis.multi();
  for (const scope of scopes) {
    const tmp = `${keys.base(scope)}${TMP_SUFFIX}`;
    if (totals[scope].size) multi.rename(tmp, keys.base(scope));
    else multi.del(keys.base(scope));
  }
  multi.set(keys.cut, String(newCutBucket));
  await multi.exec();

  for (const part of chunk(changed, 1000))
    await redis.sAdd(eventPointKeys(event.name).changed, part);
  return changed.length;
}

// Settles one season of a scored event: recompute the open days from the ledger, write them to the
// daily snapshot, and reset the live base to the season's total. Returns what it did, for the job log.
export async function runEventPointsReferee(
  event: RefereeEvent,
  season: EventPointSeason,
  now = new Date()
) {
  const window = refereeWindow(event, season, now);
  if (window.cut <= window.start) return { season, rows: 0, changed: 0 };
  const rows = await queryReferee(event, window);
  await writeDailySnapshot(event, window, rows);
  const final = await finalDayTotals(event, window);
  const changed = await resetLiveBase(
    sysRedis,
    event,
    season,
    window.cut,
    refereeTotals([...final, ...rows])
  );
  return {
    season,
    rows: rows.length,
    changed,
    recomputeFrom: window.recomputeFrom.toISOString(),
  };
}
