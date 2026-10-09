import { chunk } from 'lodash-es';
import type { EventScoring } from '~/server/events/base.event';
import { clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import { dbWrite } from '~/server/db/client';
import {
  eventPointKeys,
  eventSeasonKeys,
  hatField,
  LIVE_BUCKET_MS,
  type EventPointSeason,
  type TotalScope,
} from '~/server/events/points/keys';
import { eventPointsRefereeSql } from '~/server/events/points/referee.sql';
import { sysRedis } from '~/server/redis/client';

const DAY_MS = 24 * 60 * 60 * 1000;
// Settle only up to a bucket boundary this far back, so ledger rows still in ClickHouse's async
// insert buffer land before their bucket is settled.
const SETTLE_LAG_MS = 10 * 60 * 1000;

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

// The season's window and the cut-off this run settles to: a bucket boundary at least SETTLE_LAG_MS
// in the past, never past the season's end.
export function refereeWindow(event: RefereeEvent, season: EventPointSeason, now: Date) {
  const start = season === 'preview' ? event.previewFrom ?? event.startDate : event.startDate;
  const end = season === 'preview' ? event.startDate : event.endDate;
  const settled = Math.floor((now.getTime() - SETTLE_LAG_MS) / LIVE_BUCKET_MS) * LIVE_BUCKET_MS;
  const cut = new Date(Math.min(settled, end.getTime()));
  return { start, cut };
}

// Totals per hat, team and owner over every day of the season.
export function refereeTotals(rows: RefereeRow[]) {
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

async function queryReferee(event: RefereeEvent, start: Date, cut: Date) {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const types = Object.entries(event.scoring.types).filter(([, rule]) => !!rule);
  const weights = await sysRedis.hGetAll(eventPointKeys(event.name).weights);
  const result = await clickhouse.query({
    query: eventPointsRefereeSql,
    format: 'JSONEachRow',
    clickhouse_settings: { max_execution_time: 120 },
    query_params: {
      event: event.name,
      seasonStart: formatClickhouseDateTime64(start),
      cut: formatClickhouseDateTime64(cut),
      newAccountCutoff: formatClickhouseDateTime64(
        event.startDate.getTime() - event.scoring.newAccountDays * DAY_MS
      ),
      cap: event.scoring.capPerActorPerOwnerPerDay,
      types: types.map(([type]) => type),
      // The live weights, so the referee and the live totals agree; the config fills any gap.
      weights: types.map(([type, rule]) => {
        const live = weights?.[type] != null ? Number(weights[type]) : NaN;
        return Number.isFinite(live) ? live : rule!.weight;
      }),
      dailyTypes: types.filter(([, rule]) => rule!.once === 'day').map(([type]) => type),
    },
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

// The durable record: one row per hat per day, which the standings, the winner and the per-hat
// counts read. Recomputing the season replaces it, so a rerun never double counts.
async function writeDailySnapshot(event: RefereeEvent, start: Date, end: Date, rows: RefereeRow[]) {
  const fromDay = start.toISOString().slice(0, 10);
  const toDay = end.toISOString().slice(0, 10);
  await dbWrite.$transaction([
    dbWrite.$executeRaw`
      DELETE FROM "EventCosmeticScoreDaily"
      WHERE event = ${event.name} AND day >= ${fromDay}::date AND day <= ${toDay}::date
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

const TMP_SUFFIX = ':next';

// Replaces the live base with the referee's totals and moves the cut, in one MULTI, so a reader
// never sees the new base with the old cut (which would count the settled buckets twice).
async function resetLiveBase(
  event: RefereeEvent,
  season: EventPointSeason,
  cut: Date,
  totals: ReturnType<typeof refereeTotals>
) {
  const keys = eventSeasonKeys(event.name, season);
  const oldCutBucket = Number((await sysRedis.get(keys.cut)) ?? 0);
  const newCutBucket = cut.getTime() / LIVE_BUCKET_MS;

  const oldHatBase = (await sysRedis.hGetAll(keys.base('hat'))) ?? {};
  const settled: Record<string, string>[] = [];
  if (oldCutBucket)
    for (let b = oldCutBucket; b < newCutBucket; b++)
      settled.push((await sysRedis.hGetAll(keys.live(b, 'hat'))) ?? {});
  const changed = oldCutBucket
    ? changedHats(oldHatBase, settled, totals.hat)
    : [...totals.hat.keys()];

  const scopes: TotalScope[] = ['hat', 'team', 'owner'];
  for (const scope of scopes) {
    const tmp = `${keys.base(scope)}${TMP_SUFFIX}` as const;
    await sysRedis.del(tmp);
    for (const part of chunk([...totals[scope].entries()], 1000))
      await sysRedis.hSet(tmp, Object.fromEntries(part.map(([k, v]) => [k, String(v)])));
  }
  const multi = sysRedis.multi();
  for (const scope of scopes) {
    const tmp = `${keys.base(scope)}${TMP_SUFFIX}`;
    if (totals[scope].size) multi.rename(tmp, keys.base(scope));
    else multi.del(keys.base(scope));
  }
  multi.set(keys.cut, String(newCutBucket));
  await multi.exec();

  for (const part of chunk(changed, 1000))
    await sysRedis.sAdd(eventPointKeys(event.name).changed, part);
  return changed.length;
}

// Settles one season of a scored event: recompute from the ledger, write the daily snapshot, reset
// the live base. Returns what it did, for the job log.
export async function runEventPointsReferee(
  event: RefereeEvent,
  season: EventPointSeason,
  now = new Date()
) {
  const { start, cut } = refereeWindow(event, season, now);
  if (cut <= start) return { season, rows: 0, changed: 0 };
  const rows = await queryReferee(event, start, cut);
  await writeDailySnapshot(event, start, cut, rows);
  const changed = await resetLiveBase(event, season, cut, refereeTotals(rows));
  return { season, rows: rows.length, changed };
}
