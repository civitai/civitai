import { dbRead, dbWrite } from '~/server/db/client';
import type { EventScoring, TeamScore } from '~/server/events/base.event';
import { redis, REDIS_KEYS } from '~/server/redis/client';

export type ScoredEvent = {
  name: string;
  startDate: Date;
  endDate: Date;
  teams: readonly string[];
  scoring: EventScoring;
  // Standings and score reads count only days from here; defaults to startDate. Keeps a test run's
  // days out of the public standings even if they were never cleared.
  scoreFrom?: Date;
};

type StandingsEvent = Pick<ScoredEvent, 'name' | 'teams' | 'startDate' | 'scoreFrom'>;
const scoreFromDay = (event: Pick<ScoredEvent, 'startDate' | 'scoreFrom'>) => {
  const from = event.scoreFrom ?? event.startDate;
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
};

const TOP_COSMETICS = 50;
const TOP_USERS_PER_TEAM = 20;

export type CosmeticScoreKey = { userId: number; cosmeticId: number; claimKey: string };
export const cosmeticScoreKey = ({ userId, cosmeticId, claimKey }: CosmeticScoreKey) =>
  `${userId}:${cosmeticId}:${claimKey}`;

export type CosmeticScore = CosmeticScoreKey & {
  team: string;
  points: number;
  // Counts of the actions that scored, per type. impressions are signed-in views.
  impressions: number;
  anonImpressions: number;
  reactions: number;
  comments: number;
  stickers: number;
  remixes: number;
  modelLikes: number;
};

export type EventStandings = {
  teams: TeamScore[];
  // Cumulative points per team at the end of each scored UTC day.
  history: { team: string; scores: { date: Date; score: number }[] }[];
  topCosmetics: CosmeticScore[];
  topUsers: Record<string, { userId: number; points: number }[]>;
  updatedAt: Date;
};

// Keyed by the first counted day too, so a preview snapshot is never served as the event's.
const standingsKey = (event: StandingsEvent) => {
  const fromDay = scoreFromDay(event).toISOString().slice(0, 10);
  return `${REDIS_KEYS.EVENT.CACHE}:${event.name}:standings:${fromDay}` as const;
};

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
      sum("anonImpressions")::int AS "anonImpressions", sum(reactions)::int AS reactions,
      sum(comments)::int AS comments, sum(stickers)::int AS stickers, sum(remixes)::int AS remixes,
      sum("modelLikes")::int AS "modelLikes"
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

export async function refreshStandings(event: StandingsEvent, db: typeof dbWrite | typeof dbRead) {
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
      sum("anonImpressions")::int AS "anonImpressions", sum(reactions)::int AS reactions,
      sum(comments)::int AS comments, sum(stickers)::int AS stickers, sum(remixes)::int AS remixes,
      sum("modelLikes")::int AS "modelLikes"
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
      sum(s."anonImpressions")::int AS "anonImpressions", sum(s.reactions)::int AS reactions,
      sum(s.comments)::int AS comments, sum(s.stickers)::int AS stickers,
      sum(s.remixes)::int AS remixes, sum(s."modelLikes")::int AS "modelLikes"
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
