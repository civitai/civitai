import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import type { CosmeticPlacementScoring, TeamScore } from '~/server/events/base.event';
import { cosmeticPlacementDailyScoreSql } from '~/server/events/scoring/cosmetic-placement.sql';
import { logToAxiom } from '~/server/logging/client';
import { flagAudienceAmong } from '~/server/events/event-access';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { toUtcTimestamp as chDate } from '~/server/services/creator-milestone-exclusions';
import type { CosmeticEntity } from '~/shared/utils/prisma/enums';

export type ScoredEvent = {
  name: string;
  startDate: Date;
  endDate: Date;
  teams: readonly string[];
  scoring: CosmeticPlacementScoring;
  // Standings and score reads count only days from here; defaults to startDate. Keeps a test run's
  // days out of the public standings even if they were never cleared.
  scoreFrom?: Date;
  // While set, only cosmetics owned by users this Flipt flag is on for score.
  audienceFlag?: string;
};

type StandingsEvent = Pick<ScoredEvent, 'name' | 'teams' | 'startDate' | 'scoreFrom'>;
const scoreFromDay = (event: Pick<ScoredEvent, 'startDate' | 'scoreFrom'>) => {
  const from = event.scoreFrom ?? event.startDate;
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
};

const DAY_MS = 24 * 60 * 60 * 1000;
// Impressions and reactions arrive late (client batches flush up to 90s later, async inserts), so a
// finished UTC day is recomputed until this long after it ends, then left alone.
const LATE_DATA_MS = 6 * 60 * 60 * 1000;
const TOP_COSMETICS = 50;
const TOP_USERS_PER_TEAM = 20;

export type CosmeticScoreKey = { userId: number; cosmeticId: number; claimKey: string };
export const cosmeticScoreKey = ({ userId, cosmeticId, claimKey }: CosmeticScoreKey) =>
  `${userId}:${cosmeticId}:${claimKey}`;

export type CosmeticScore = CosmeticScoreKey & {
  team: string;
  points: number;
  impressions: number;
  anonImpressions: number;
  reactions: number;
};

export type EventStandings = {
  teams: TeamScore[];
  // Cumulative points per team at the end of each scored UTC day.
  history: { team: string; scores: { date: Date; score: number }[] }[];
  topCosmetics: CosmeticScore[];
  topUsers: Record<string, { userId: number; points: number }[]>;
  updatedAt: Date;
};

export function scorePoints(
  row: { impressions: number; anonImpressions: number; reactions: number },
  scoring: Pick<CosmeticPlacementScoring, 'reactionWeight'>
) {
  return row.impressions + row.anonImpressions + row.reactions * scoring.reactionWeight;
}

// The UTC days to (re)score at `now`: today so far, plus yesterday while its late data may still land.
// Clipped to the event window; empty before the event starts.
export function daysToScore(event: Pick<ScoredEvent, 'startDate' | 'endDate'>, now: Date) {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const candidates = [startOfToday - DAY_MS, startOfToday];
  const days: { day: Date; start: Date; end: Date }[] = [];
  for (const dayStart of candidates) {
    const dayEnd = dayStart + DAY_MS;
    if (dayStart < startOfToday && now.getTime() >= dayEnd + LATE_DATA_MS) continue;
    const start = Math.max(dayStart, event.startDate.getTime());
    const end = Math.min(dayEnd, event.endDate.getTime(), now.getTime());
    if (start >= end) continue;
    days.push({ day: new Date(dayStart), start: new Date(start), end: new Date(end) });
  }
  return days;
}

const syncWatermarkKey = (event: string) =>
  `${REDIS_KEYS.EVENT.CACHE}:${event}:placement-sync` as const;
// Keyed by the first counted day too, so a preview snapshot is never served as the event's.
const standingsKey = (event: StandingsEvent) => {
  const fromDay = scoreFromDay(event).toISOString().slice(0, 10);
  return `${REDIS_KEYS.EVENT.CACHE}:${event.name}:standings:${fromDay}` as const;
};

// Mirror ledger rows changed since the last run into ClickHouse. ReplacingMergeTree keeps the latest
// version of each id, so re-sending rows is harmless; the watermark is rewound a little to cover
// transactions that committed after a later-stamped one was read.
async function syncPlacements(event: string) {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const watermark = await redis.get(syncWatermarkKey(event));
  const since = watermark ? new Date(Number(watermark) - 5 * 60 * 1000) : new Date(0);

  const rows = await dbWrite.eventCosmeticPlacement.findMany({
    where: { event, updatedAt: { gte: since } },
    orderBy: { updatedAt: 'asc' },
  });
  if (!rows.length) return 0;

  await clickhouse.insert({
    table: 'event_cosmetic_placements',
    format: 'JSONEachRow',
    // Synchronous: the score query in this same run must see these rows.
    clickhouse_settings: { async_insert: 0 },
    values: rows.map((r) => ({
      id: Number(r.id),
      event: r.event,
      userId: r.userId,
      cosmeticId: r.cosmeticId,
      claimKey: r.claimKey,
      team: r.team,
      entityType: r.entityType,
      entityId: r.entityId,
      entityOwnerId: r.entityOwnerId ?? 0,
      startedAt: chDate(r.startedAt),
      endedAt: r.endedAt ? chDate(r.endedAt) : null,
      updatedAt: chDate(r.updatedAt),
    })),
  });

  const latest = rows[rows.length - 1].updatedAt.getTime();
  await redis.set(syncWatermarkKey(event), latest.toString());
  return rows.length;
}

type ScoreRow = {
  userId: number;
  cosmeticId: number;
  claimKey: string;
  team: string;
  impressions: number;
  anonImpressions: number;
  reactions: number;
};

async function scoreDay(event: ScoredEvent, window: { day: Date; start: Date; end: Date }) {
  if (!clickhouse) throw new Error('ClickHouse is not configured');
  const { scoring } = event;
  const newAccountCutoff = new Date(event.startDate.getTime() - scoring.newAccountDays * DAY_MS);
  const result = await clickhouse.query({
    query: cosmeticPlacementDailyScoreSql,
    format: 'JSONEachRow',
    // A slow hour fails under these limits rather than at the socket timeout; the next run
    // recomputes the whole day, so a failed hour loses nothing.
    clickhouse_settings: { max_execution_time: 120, max_memory_usage: '16000000000' },
    query_params: {
      event: event.name,
      dayStart: chDate(window.start),
      dayEnd: chDate(window.end),
      eventStart: chDate(event.startDate),
      newAccountCutoff: chDate(newAccountCutoff),
      botLimit: scoring.botSessionEntityLimit,
      viewerCap: scoring.viewerOwnerDailyCap,
      anonFloor: scoring.anonFloor,
      anonRatio: scoring.anonRatio,
    },
  });
  let rows = (await result.json<ScoreRow>()).map((r) => ({
    userId: Number(r.userId),
    cosmeticId: Number(r.cosmeticId),
    claimKey: String(r.claimKey),
    team: String(r.team),
    impressions: Number(r.impressions),
    anonImpressions: Number(r.anonImpressions),
    reactions: Number(r.reactions),
  }));
  // The placement ledger records every equip, whoever made it; the flag decides who scores.
  if (event.audienceFlag) {
    const audience = await flagAudienceAmong(event.audienceFlag, [
      ...new Set(rows.map((r) => r.userId)),
    ]);
    rows = rows.filter((r) => audience.has(r.userId));
  }

  // Recomputing a day replaces it, so a rerun can never double count.
  await dbWrite.$transaction([
    dbWrite.$executeRaw`
      DELETE FROM "EventCosmeticScoreDaily" WHERE event = ${event.name} AND day = ${window.day}::date
    `,
    ...chunk(rows, 5000).map(
      (part) => dbWrite.$executeRaw`
        INSERT INTO "EventCosmeticScoreDaily"
          (event, day, "userId", "cosmeticId", "claimKey", team, impressions, "anonImpressions", reactions, points)
        SELECT ${event.name}, ${window.day}::date, u.*
        FROM unnest(
          ${part.map((r) => r.userId)}::int[],
          ${part.map((r) => r.cosmeticId)}::int[],
          ${part.map((r) => r.claimKey)}::text[],
          ${part.map((r) => r.team)}::text[],
          ${part.map((r) => r.impressions)}::int[],
          ${part.map((r) => r.anonImpressions)}::int[],
          ${part.map((r) => r.reactions)}::int[],
          ${part.map((r) => scorePoints(r, scoring))}::int[]
        ) AS u
      `
    ),
  ]);
  return rows.length;
}

export async function runCosmeticPlacementScoring(event: ScoredEvent, now = new Date()) {
  const days = daysToScore(event, now);
  if (!days.length) return { synced: 0, scored: [] as number[] };

  const synced = await syncPlacements(event.name);
  const scored: number[] = [];
  for (const window of days) scored.push(await scoreDay(event, window));

  await refreshStandings(event, dbWrite);
  logToAxiom({ type: 'info', name: 'event-scoring', event: event.name, synced, scored }).catch(
    () => undefined
  );
  return { synced, scored };
}

// Banned, deleted and leaderboard-excluded users drop out of the standings (team totals, history and
// rankings). Their rows stay in the table, so a reversal restores them; per-cosmetic reads below are
// not filtered. The hourly job passes the primary: it builds this right after writing the day, and
// a lagging replica would freeze stale numbers into the snapshot for an hour.
async function computeStandings(event: StandingsEvent, db: typeof dbWrite | typeof dbRead) {
  const fromDay = scoreFromDay(event);
  // The few hidden users, found once over the event's distinct users, so the three aggregates below
  // need no per-row join to "User".
  const hidden = await db.$queryRaw<{ id: number }[]>`
    SELECT u.id FROM "User" u
    WHERE u.id IN (
      SELECT DISTINCT "userId" FROM "EventCosmeticScoreDaily"
      WHERE event = ${event.name} AND day >= ${fromDay}::date
    )
      AND (u."bannedAt" IS NOT NULL OR u."deletedAt" IS NOT NULL OR u."excludeFromLeaderboards")
  `;
  const hiddenIds = hidden.map((u) => u.id);

  const teamDays = await db.$queryRaw<{ team: string; day: Date; points: number }[]>`
    SELECT team, day, sum(points)::int AS points
    FROM "EventCosmeticScoreDaily"
    WHERE event = ${event.name} AND day >= ${fromDay}::date AND "userId" <> ALL(${hiddenIds}::int[])
    GROUP BY team, day
    ORDER BY day
  `;
  const totals = new Map<string, number>();
  const history = event.teams.map((team) => ({
    team,
    scores: [] as { date: Date; score: number }[],
  }));
  for (const { team, day, points } of teamDays) {
    const total = (totals.get(team) ?? 0) + points;
    totals.set(team, total);
    history.find((h) => h.team === team)?.scores.push({ date: day, score: total });
  }
  const teams: TeamScore[] = event.teams.map((team) => ({
    team,
    score: totals.get(team) ?? 0,
    rank: 0,
  }));
  teams.sort((a, b) => b.score - a.score);
  teams.forEach((t, i) => (t.rank = i + 1));

  const topCosmetics = await db.$queryRaw<CosmeticScore[]>`
    SELECT "userId", "cosmeticId", "claimKey", team,
      sum(points)::int AS points, sum(impressions)::int AS impressions,
      sum("anonImpressions")::int AS "anonImpressions", sum(reactions)::int AS reactions
    FROM "EventCosmeticScoreDaily"
    WHERE event = ${event.name} AND day >= ${fromDay}::date AND "userId" <> ALL(${hiddenIds}::int[])
    GROUP BY "userId", "cosmeticId", "claimKey", team
    ORDER BY points DESC
    LIMIT ${TOP_COSMETICS}
  `;

  const userRows = await db.$queryRaw<{ team: string; userId: number; points: number }[]>`
    SELECT team, "userId", points FROM (
      SELECT team, "userId", sum(points)::int AS points,
        row_number() OVER (PARTITION BY team ORDER BY sum(points) DESC) AS rn
      FROM "EventCosmeticScoreDaily"
      WHERE event = ${event.name} AND day >= ${fromDay}::date
        AND "userId" <> ALL(${hiddenIds}::int[])
      GROUP BY team, "userId"
    ) ranked
    WHERE rn <= ${TOP_USERS_PER_TEAM}
    ORDER BY team, points DESC
  `;
  const topUsers: EventStandings['topUsers'] = {};
  for (const { team, userId, points } of userRows) (topUsers[team] ??= []).push({ userId, points });

  return { teams, history, topCosmetics, topUsers, updatedAt: new Date() } satisfies EventStandings;
}

async function refreshStandings(event: StandingsEvent, db: typeof dbWrite | typeof dbRead) {
  const standings = await computeStandings(event, db);
  await redis.packed.set(standingsKey(event), standings, { EX: 2 * 60 * 60 });
  return standings;
}

// Served from the snapshot the hourly job writes; a miss (no run for 2h) recomputes once here.
export async function getEventStandings(event: StandingsEvent) {
  const cached = await redis.packed.get<EventStandings>(standingsKey(event));
  if (cached) return cached;
  // Request path: a cold snapshot is rebuilt from the replica, never the primary.
  return refreshStandings(event, dbRead);
}

export async function getTeamScoreHistory(event: StandingsEvent) {
  return (await getEventStandings(event)).history;
}

export async function getUserCosmeticScores(event: StandingsEvent, userId: number) {
  return dbRead.$queryRaw<CosmeticScore[]>`
    SELECT "userId", "cosmeticId", "claimKey", team,
      sum(points)::int AS points, sum(impressions)::int AS impressions,
      sum("anonImpressions")::int AS "anonImpressions", sum(reactions)::int AS reactions
    FROM "EventCosmeticScoreDaily"
    WHERE event = ${event.name} AND day >= ${scoreFromDay(event)}::date AND "userId" = ${userId}
    GROUP BY "userId", "cosmeticId", "claimKey", team
    ORDER BY points DESC
  `;
}

export async function getCosmeticScores(event: StandingsEvent, keys: CosmeticScoreKey[]) {
  if (!keys.length) return {} as Record<string, CosmeticScore>;
  const rows = await dbRead.$queryRaw<CosmeticScore[]>`
    SELECT s."userId", s."cosmeticId", s."claimKey", s.team,
      sum(s.points)::int AS points, sum(s.impressions)::int AS impressions,
      sum(s."anonImpressions")::int AS "anonImpressions", sum(s.reactions)::int AS reactions
    FROM "EventCosmeticScoreDaily" s
    JOIN unnest(
      ${keys.map((k) => k.userId)}::int[],
      ${keys.map((k) => k.cosmeticId)}::int[],
      ${keys.map((k) => k.claimKey)}::text[]
    ) AS k("userId", "cosmeticId", "claimKey")
      ON k."userId" = s."userId" AND k."cosmeticId" = s."cosmeticId" AND k."claimKey" = s."claimKey"
    WHERE s.event = ${event.name} AND s.day >= ${scoreFromDay(event)}::date
    GROUP BY s."userId", s."cosmeticId", s."claimKey", s.team
  `;
  return Object.fromEntries(rows.map((r) => [cosmeticScoreKey(r), r]));
}

// End of a scored event: take every one of its cosmetics off content. The placement trigger closes
// each interval as the columns clear. Returns the entities that lost a cosmetic so their caches can
// be refreshed.
export async function unequipEventCosmetics(event: string) {
  return dbWrite.$queryRaw<{ entityType: CosmeticEntity; entityId: number }[]>`
    WITH targets AS (
      SELECT uc."userId", uc."cosmeticId", uc."claimKey", uc."equippedToType", uc."equippedToId"
      FROM "UserCosmetic" uc
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      WHERE c.type = 'ContentDecoration'
        AND c.data->>'event' = ${event}
        AND uc."equippedToId" IS NOT NULL
      FOR UPDATE OF uc
    )
    UPDATE "UserCosmetic" uc
    SET "equippedToId" = NULL, "equippedToType" = NULL, "equippedAt" = NULL
    FROM targets t
    WHERE uc."userId" = t."userId" AND uc."cosmeticId" = t."cosmeticId" AND uc."claimKey" = t."claimKey"
    RETURNING t."equippedToType" AS "entityType", t."equippedToId" AS "entityId"
  `;
}
