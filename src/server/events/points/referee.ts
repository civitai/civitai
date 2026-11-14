import { randomUUID } from 'crypto';
import { chunk } from 'lodash-es';
import { TURF_CLAIM_KEY } from '~/server/events/turf/turf-map';
import type { EventScoring } from '~/server/events/base.event';
import { clickhouseLongQueries as clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  eventPointKeys,
  eventPointSeason,
  eventPointsWindow,
  COUNT_BASE_MARK,
  countField,
  eventSeasonKeys,
  hatField,
  LIVE_BUCKET_MS,
  parseHatField,
  utcDay,
  TEAM_HOURS_CUT_FIELD,
  type EventPointSeason,
  type TotalScope,
} from '~/server/events/points/keys';
import {
  eventPointsRefereeSql,
  eventPointsRefereeUsersSql,
} from '~/server/events/points/referee.sql';
import { drainEventPointsPush, markEventPointsDirty } from '~/server/events/points/push';
import type { EventPointType } from '~/server/events/points/types';
import { sysRedis } from '~/server/redis/client';
import { UserFlag } from '~/shared/constants/user-flags.constants';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { logToAxiom } from '~/server/logging/client';
import { freezeEventAwards } from '~/server/events/scoring/award-results';
import {
  clientAbortAfter,
  LONG_QUERY_PROGRESS_SETTINGS,
} from '~/server/events/points/clickhouse-limits';
import { loadTeamAwards } from '~/server/events/scoring/team-awards';
import type { TeamAward } from '~/server/events/base.event';

const DAY_MS = 24 * 60 * 60 * 1000;
// Settle only up to a bucket boundary this far back, so ledger rows still in ClickHouse's async
// insert buffer land before their bucket is settled.
const SETTLE_LAG_MS = 10 * 60 * 1000;
// The hour (UTC) whose run recomputes the whole season, picking up late removals and bans on days
// the hourly runs treat as final.
const FULL_RECOMPUTE_HOUR = 3;
// Both ClickHouse queries of one settle together, sized for a whole-season window (the nightly run,
// and every run once the season has ended). It, the hat sync and the Postgres and Redis writes must
// stay under SETTLE_LOCK_S.
export const REFEREE_CLICKHOUSE_BUDGET_S = 35 * 60;
// The settle job's lock, shared with the self-heal so the two never settle at once. Keep it under the
// hourly cron, or a run is skipped while the last still holds it.
export const SETTLE_LOCK_S = 45 * 60;
// One missed hourly settle is normal lag; two means settles are failing.
export const STALE_CUT_ALERT_MS = 2 * 60 * 60 * 1000;

// Named in a failure's message, so the job's log can be joined to system.query_log on the node that ran it.
const refereeQueryId = (event: RefereeEvent, step: 'users' | 'settle') =>
  `event-points-referee:${event.name}:${step}:${randomUUID()}`;
async function withQueryId<T>(queryId: string, run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error) error.message = `${error.message} (query_id ${queryId})`;
    throw error;
  }
}

// The cap for the next referee query, on the server and on the client.
function queryLimit(deadline: number) {
  const seconds = Math.floor((deadline - Date.now()) / 1000);
  if (seconds < 1) throw new Error('Referee ClickHouse budget spent');
  return { seconds, signal: clientAbortAfter(seconds) };
}

export type RefereeEvent = {
  name: string;
  startDate: Date;
  endDate: Date;
  teams: readonly string[];
  previewFrom?: Date;
  scoring: EventScoring;
  // Finds an entrant's team when an award result is frozen.
  join?: { claimKey: string; design: string };
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
  // UTC hour (0-23) -> points granted in it.
  hours: Record<number, number>;
};

const startOfUtcDay = (time: Date) =>
  new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()));

// The season's window: the cut-off adds settle to (a bucket boundary at least SETTLE_LAG_MS in the
// past, never past the season's end), the cut-off removals settle to (the same boundary, but running
// on through the live season's finalize window), and the first day it recomputes: the day before the
// cut's day, or the whole season on the nightly full run and on every run once the season has ended.
// `final`: this run settles the live season's whole finalize window, so its totals are the final ones.
export function refereeWindow(event: RefereeEvent, season: EventPointSeason, now: Date) {
  const start = season === 'preview' ? event.previewFrom ?? event.startDate : event.startDate;
  const end = season === 'preview' ? event.startDate : event.endDate;
  const settled = Math.floor((now.getTime() - SETTLE_LAG_MS) / LIVE_BUCKET_MS) * LIVE_BUCKET_MS;
  const cut = new Date(Math.min(settled, end.getTime()));
  // A takedown in the finalize window must still net out the add it pairs with, before the winner
  // is decided on these totals.
  const removeEnd = season === 'live' ? eventPointsWindow(event).to.getTime() : end.getTime();
  const removeCut = new Date(Math.min(settled, removeEnd));
  const final = season === 'live' && settled >= removeEnd;
  // Once the season has ended a late removal can reach any day, so no day is final.
  const full = now.getUTCHours() === FULL_RECOMPUTE_HOUR || settled >= end.getTime();
  const dayBefore = new Date(startOfUtcDay(cut).getTime() - DAY_MS);
  const recomputeFrom = full || dayBefore < start ? start : dayBefore;
  return {
    start,
    cut,
    removeCut,
    recomputeFrom,
    final,
  };
}

// Totals per hat, team and owner: the final days from the snapshot plus the recomputed rows.
// A row's per-type counts, keyed by the ledger's type names.
const ROW_COUNTS = {
  view: 'views',
  reaction: 'reactions',
  comment: 'comments',
  sticker: 'stickers',
  remix: 'remixes',
  modelLike: 'modelLikes',
} as const satisfies Record<EventPointType, keyof RefereeRow>;

export function refereeTotals(
  rows: Pick<
    RefereeRow,
    'userId' | 'cosmeticId' | 'claimKey' | 'team' | 'points' | (typeof ROW_COUNTS)[EventPointType]
  >[]
) {
  const totals: Record<TotalScope, Map<string, number>> = {
    hat: new Map(),
    team: new Map(),
    owner: new Map(),
    count: new Map(),
  };
  const add = (scope: TotalScope, key: string, points: number) =>
    totals[scope].set(key, (totals[scope].get(key) ?? 0) + points);
  for (const r of rows) {
    if (!r.points) continue;
    const hat = { ownerId: r.userId, cosmeticId: r.cosmeticId, claimKey: r.claimKey };
    add('hat', hatField(hat), r.points);
    add('team', r.team, r.points);
    add('owner', String(r.userId), r.points);
    for (const [type, column] of Object.entries(ROW_COUNTS) as [
      EventPointType,
      (typeof ROW_COUNTS)[EventPointType]
    ][])
      if (r[column]) add('count', countField(type, hat), r[column]);
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
  restricted: { hidden: number[]; newAccountMinId: number }
) {
  const types = Object.entries(event.scoring.types).filter(([, rule]) => !!rule);
  return {
    event: event.name,
    seasonStart: formatClickhouseDateTime64(window.start),
    recomputeFrom: formatClickhouseDateTime64(window.recomputeFrom),
    cut: formatClickhouseDateTime64(window.cut),
    removeCut: formatClickhouseDateTime64(window.removeCut),
    cap: event.scoring.capPerActorPerOwnerPerDay,
    types: types.map(([type]) => type),
    // The live weights, so the referee and the live totals agree; the config fills any gap.
    weights: types.map(([type, rule]) => {
      const live = liveWeights?.[type] != null ? Number(liveWeights[type]) : NaN;
      return Number.isFinite(live) ? live : rule!.weight;
    }),
    dailyTypes: types.filter(([, rule]) => rule!.once === 'day').map(([type]) => type),
    restrictedUsers: restricted.hidden,
    newAccountMinId: restricted.newAccountMinId,
  };
}

const MAX_INT32 = 2147483647;

// Who must not earn or give points. Hidden (banned, deleted, excluded from event points): looked up
// in Postgres among the people the recomputed rows involve. New accounts: every id from the first
// account registered inside the new-account window, since ids are assigned in registration order.
// A threshold, not a list: a month of signups is ~250k ids, past what fits in a query's URL.
async function restrictedUsers(event: RefereeEvent, window: Window, deadline: number) {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const params = refereeQueryParams(event, window, undefined, {
    hidden: [],
    newAccountMinId: MAX_INT32,
  });
  const limit = queryLimit(deadline);
  const queryId = refereeQueryId(event, 'users');
  const result = await withQueryId(queryId, () =>
    clickhouse!.query({
      query: eventPointsRefereeUsersSql,
      format: 'JSONEachRow',
      query_id: queryId,
      abort_signal: limit.signal,
      clickhouse_settings: {
        max_execution_time: limit.seconds,
        ...LONG_QUERY_PROGRESS_SETTINGS,
      },
      query_params: params,
    })
  );
  const [users] = await withQueryId(queryId, () =>
    result.json<{ actors: number[]; owners: number[] }>()
  );
  const ids = [...new Set([...(users?.actors ?? []), ...(users?.owners ?? [])].map(Number))];

  const hidden: number[] = [];
  for (const part of chunk(ids, 10_000)) {
    const rows = await dbRead.$queryRaw<{ id: number }[]>`
      SELECT id FROM "User"
      WHERE id = ANY(${part}::int[])
        AND ("bannedAt" IS NOT NULL OR "deletedAt" IS NOT NULL OR (flags & ${UserFlag.ExcludeFromEventPoints}::int) <> 0)
    `;
    hidden.push(...rows.map((r) => r.id));
  }

  const newAccountCutoff = new Date(
    event.startDate.getTime() - event.scoring.newAccountDays * DAY_MS
  );
  // Ordered by createdAt with the deletedAt filter so it walks the partial createdAt index; min(id)
  // would scan the primary key from the oldest account. A deleted account is restricted as hidden.
  const [first] = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT id FROM "User"
    WHERE "createdAt" >= ${newAccountCutoff} AND "deletedAt" IS NULL
    ORDER BY "createdAt"
    LIMIT 1
  `;
  return { hidden, newAccountMinId: first?.id ?? MAX_INT32 };
}

export async function queryReferee(
  event: RefereeEvent,
  window: Window,
  deadline = Date.now() + REFEREE_CLICKHOUSE_BUDGET_S * 1000
) {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const [weights, restricted] = await Promise.all([
    sysRedis.hGetAll(eventPointKeys(event.name).weights),
    restrictedUsers(event, window, deadline),
  ]);
  const limit = queryLimit(deadline);
  const queryId = refereeQueryId(event, 'settle');
  const result = await withQueryId(queryId, () =>
    clickhouse!.query({
      query: eventPointsRefereeSql,
      format: 'JSONEachRow',
      query_id: queryId,
      abort_signal: limit.signal,
      // A whole-season run on the nightly pass groups every first of the season; spill to disk rather
      // than fail on memory, and allow it the time.
      clickhouse_settings: {
        max_execution_time: limit.seconds,
        ...LONG_QUERY_PROGRESS_SETTINGS,
        max_bytes_before_external_group_by: '8000000000',
        max_bytes_before_external_sort: '8000000000',
      },
      query_params: refereeQueryParams(event, window, weights, restricted),
    })
  );
  return (await withQueryId(queryId, () => result.json<RefereeRow>())).map((r) => ({
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
    hours: Object.fromEntries(
      Object.entries(r.hours ?? {}).map(([hour, points]) => [Number(hour), Number(points)])
    ),
  }));
}

// The durable record: one row per hat per day, which the standings, the winner and the per-hat
// counts read. Recomputing a day replaces it, so a rerun never double counts. Days before
// recomputeFrom are left as they are.
async function writeDailySnapshot(event: RefereeEvent, window: Window, rows: RefereeRow[]) {
  await dbWrite.$transaction([
    dbWrite.$executeRaw`
      DELETE FROM "EventCosmeticScoreDaily"
      WHERE event = ${event.name}
        AND day >= ${utcDay(window.recomputeFrom)}::date AND day <= ${utcDay(window.cut)}::date
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
    {
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
    }[]
  >`
    SELECT "userId", "cosmeticId", "claimKey", min(team) AS team, sum(points)::int AS points,
      sum(impressions)::int AS views, sum(reactions)::int AS reactions,
      sum(comments)::int AS comments, sum(stickers)::int AS stickers,
      sum(remixes)::int AS remixes, sum("modelLikes")::int AS "modelLikes"
    FROM "EventCosmeticScoreDaily"
    WHERE event = ${event.name}
      AND day >= ${utcDay(window.start)}::date AND day < ${utcDay(window.recomputeFrom)}::date
    GROUP BY "userId", "cosmeticId", "claimKey"
  `;
}

// Every day the run recomputed, empty days included, so a day that lost all its points is cleared.
export function teamHoursByDay(
  window: Pick<Window, 'recomputeFrom' | 'cut'>,
  rows: Pick<RefereeRow, 'day' | 'team' | 'hours'>[],
  awards: readonly TeamAward[] = []
) {
  const days = new Map<string, Record<string, number[]>>();
  for (
    let t = startOfUtcDay(window.recomputeFrom).getTime();
    t <= window.cut.getTime();
    t += DAY_MS
  )
    days.set(utcDay(new Date(t)), {});
  const awarded = awards.map(({ team, points, at }) => ({
    day: utcDay(at),
    team,
    hours: { [at.getUTCHours()]: points },
  }));
  for (const { day, team, hours } of [...rows, ...awarded]) {
    const teams = days.get(day);
    if (!teams) continue;
    const byHour = (teams[team] ??= new Array<number>(24).fill(0));
    for (const [hour, points] of Object.entries(hours)) byHour[Number(hour)] += points;
  }
  return days;
}

async function writeTeamHours(event: RefereeEvent, window: Window, rows: RefereeRow[]) {
  // Points earned by play only. Team awards (a Crucible's lump sum) count in totals and standings,
  // but one hour of hundreds of thousands would flatten every other hour of the chart.
  const days = teamHoursByDay(window, rows);
  await sysRedis.hSet(eventSeasonKeys(event.name, 'live').teamHours, {
    ...Object.fromEntries([...days].map(([day, teams]) => [day, JSON.stringify(teams)])),
    [TEAM_HOURS_CUT_FIELD]: window.cut.toISOString(),
  });
}

export type RefereeRedis = Pick<typeof sysRedis, 'get' | 'hGetAll' | 'del' | 'hSet' | 'multi'>;

const TMP_SUFFIX = ':next';

// Replaces the live base with the referee's totals and moves the cut, in one MULTI, so a reader
// never sees the new base with the old cut (which would count the settled buckets twice). Returns the
// hats whose shown total moved, so the correction can be pushed.
export async function resetLiveBase(
  redis: RefereeRedis,
  event: { name: string },
  season: EventPointSeason,
  { cut, removeCut }: Pick<Window, 'cut' | 'removeCut'>,
  totals: ReturnType<typeof refereeTotals>
) {
  const keys = eventSeasonKeys(event.name, season);
  const oldCutBucket = Number((await redis.get(keys.cut)) ?? 0);
  // Rounded up: a season end inside a bucket settles all of it, since nothing after the end is live.
  const newCutBucket = Math.ceil(cut.getTime() / LIVE_BUCKET_MS);

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

  const scopes: TotalScope[] = ['hat', 'team', 'owner', 'count'];
  const bases = { ...totals, count: new Map([...totals.count, [COUNT_BASE_MARK, 1]]) };
  for (const scope of scopes) {
    const tmp = `${keys.base(scope)}${TMP_SUFFIX}` as const;
    await redis.del(tmp);
    for (const part of chunk([...bases[scope].entries()], 1000))
      await redis.hSet(tmp, Object.fromEntries(part.map(([k, v]) => [k, String(v)])));
  }
  const multi = redis.multi();
  for (const scope of scopes) {
    const tmp = `${keys.base(scope)}${TMP_SUFFIX}`;
    if (bases[scope].size) multi.rename(tmp, keys.base(scope));
    else multi.del(keys.base(scope));
  }
  multi.set(keys.cut, String(newCutBucket));
  multi.set(keys.removeCut, String(removeCut.getTime()));
  await multi.exec();
  return changed;
}

// Measured against the removal cut a run should reach, not the clock, so a fully settled season never
// trips it. The cut stops at the season's end, so it could not see a stuck finalize window.
export async function alertOnStaleCut(
  redis: Pick<RefereeRedis, 'get'>,
  event: { name: string },
  season: EventPointSeason,
  removeCut: Date
) {
  const keys = eventSeasonKeys(event.name, season);
  const [cutBucket, settledTo] = await Promise.all([
    redis.get(keys.cut),
    redis.get(keys.removeCut),
  ]);
  // Bases written before removeCut existed: their cut is where removals were settled to.
  const stored = Number(settledTo ?? 0) || Number(cutBucket ?? 0) * LIVE_BUCKET_MS;
  if (!stored) return;
  const lagMs = removeCut.getTime() - stored;
  if (lagMs <= STALE_CUT_ALERT_MS) return;
  logToAxiom({
    type: 'error',
    name: 'event-points-cut-stale',
    event: event.name,
    season,
    cutAgeMinutes: Math.round(lagMs / 60_000),
    storedCut: new Date(stored).toISOString(),
  }).catch(() => undefined);
}

// Settles one season of a scored event: recompute the open days from the ledger, write them to the
// daily snapshot, and reset the live base to the season's total. Returns what it did, for the job log.
export async function runEventPointsReferee(
  event: RefereeEvent,
  season: EventPointSeason,
  now = new Date(),
  // Shared by every settle under one hold of the lock, so a run settling several events stays in it.
  deadline = Date.now() + REFEREE_CLICKHOUSE_BUDGET_S * 1000
) {
  const window = refereeWindow(event, season, now);
  if (window.cut <= window.start) return { season, rows: 0, changed: 0, final: false };
  await alertOnStaleCut(sysRedis, event, season, window.removeCut);
  const rows = await queryReferee(event, window, deadline);
  // Before the snapshot: if an award source can't be read, the settle stops here and the last good
  // base stands, rather than publishing totals that are missing awards.
  await freezeEventAwards(event, now);
  // A preview's cut never passes the start, so no award reaches its base.
  const awards = await loadTeamAwards(event, window.cut);
  await writeDailySnapshot(event, window, rows);
  const final = await finalDayTotals(event, window);
  const totals = refereeTotals([...final, ...rows]);
  for (const { team, points } of awards)
    totals.team.set(team, (totals.team.get(team) ?? 0) + points);
  const changed = await resetLiveBase(sysRedis, event, season, window, totals);
  // This runs in a job: its corrections go out before it returns, not on a later window, except the
  // team totals while another server holds their push lease: this server retries those on its own
  // timer a window later, so it relies on the job running in a long-lived app process. A season's
  // corrections are pushed while it is the current one: the preview's settle after the start would
  // go to the live topics. `unpushed` counts those the pusher refused (paused or off). What the
  // drain leaves unsent it logs itself.
  let unpushed = 0;
  if (season === eventPointSeason(event.startDate, now) && changed.length) {
    for (const field of changed) {
      const hat = parseHatField(field);
      // Turf credits have no live hat bucket, so every one reads as changed here, and none has a hat
      // card on screen: marking them would crowd real hats out of the dirty set.
      if (hat?.claimKey === TURF_CLAIM_KEY) continue;
      if (!hat || !markEventPointsDirty(event, hat, now)) unpushed++;
    }
    await drainEventPointsPush();
  }
  // Feeds only the chart: a failed write must not fail a settle that has already landed.
  if (season === 'live')
    await writeTeamHours(event, window, rows).catch((error) =>
      logSysRedisFailOpen('write-degraded', 'writeTeamHours', error, { event: event.name })
    );
  return {
    season,
    rows: rows.length,
    changed: changed.length,
    unpushed,
    recomputeFrom: window.recomputeFrom.toISOString(),
    final: window.final,
  };
}
