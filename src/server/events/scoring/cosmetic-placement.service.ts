import { chunk } from 'lodash-es';
import { hatField } from '~/server/events/points/keys';
import type { dbRead, dbWrite } from '~/server/db/client';
import type { EventScoring, TeamScore } from '~/server/events/base.event';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

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
// The same string as the live totals' hat field: live and settled points are merged by it.
export const cosmeticScoreKey = ({ userId, cosmeticId, claimKey }: CosmeticScoreKey) =>
  hatField({ ownerId: userId, cosmeticId, claimKey });

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
  // NOT IN over a subquery is hashed; <> ALL(array) compares every row with the whole array.

  const teamDays = await db.$queryRaw<{ team: string; day: Date; points: number }[]>`
    SELECT team, day, sum(points)::int AS points
    FROM "EventCosmeticScoreDaily"
    WHERE event = ${event.name} AND day >= ${fromDay}::date AND "userId" NOT IN (SELECT unnest(${hiddenIds}::int[]))
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
    WHERE event = ${event.name} AND day >= ${fromDay}::date AND "userId" NOT IN (SELECT unnest(${hiddenIds}::int[]))
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
        AND "userId" NOT IN (SELECT unnest(${hiddenIds}::int[]))
      GROUP BY team, "userId"
    ) ranked
    WHERE rn <= ${TOP_USERS_PER_TEAM}
    ORDER BY team, points DESC
  `;
  const topUsers: EventStandings['topUsers'] = {};
  for (const { team, userId, points } of userRows) (topUsers[team] ??= []).push({ userId, points });

  return { teams, history, topCosmetics, topUsers, updatedAt: new Date() } satisfies EventStandings;
}

// What the request path serves, written by the hourly job and never rebuilt on a request: the
// standings, and each hat's season totals with an index of each owner's hats. On sysRedis, not the
// evicting cache, so the final numbers outlive the event once the job stops writing.
// Keyed by the first counted day too, so a preview snapshot is never served as the event's.
const snapshotKeys = (event: StandingsEvent) => {
  const fromDay = scoreFromDay(event).toISOString().slice(0, 10);
  const root = `${REDIS_SYS_KEYS.EVENT}:${event.name}:snapshot:${fromDay}` as const;
  return {
    standings: `${root}:standings` as const,
    hats: `${root}:hats` as const,
    owners: `${root}:owners` as const,
  };
};

async function hatTotals(event: StandingsEvent, db: typeof dbWrite | typeof dbRead) {
  return db.$queryRaw<CosmeticScore[]>`
    SELECT "userId", "cosmeticId", "claimKey", min(team) AS team,
      sum(points)::int AS points, sum(impressions)::int AS impressions,
      sum("anonImpressions")::int AS "anonImpressions", sum(reactions)::int AS reactions,
      sum(comments)::int AS comments, sum(stickers)::int AS stickers, sum(remixes)::int AS remixes,
      sum("modelLikes")::int AS "modelLikes"
    FROM "EventCosmeticScoreDaily"
    WHERE event = ${event.name} AND day >= ${scoreFromDay(event)}::date
    GROUP BY "userId", "cosmeticId", "claimKey"
  `;
}

// Written to temporary keys and renamed into place together, so a reader never sees half a run.
async function writeHatTotals(event: StandingsEvent, hats: CosmeticScore[]) {
  const keys = snapshotKeys(event);
  const owners = new Map<number, string[]>();
  for (const hat of hats)
    owners.set(hat.userId, [...(owners.get(hat.userId) ?? []), cosmeticScoreKey(hat)]);
  const next = { hats: `${keys.hats}:next` as const, owners: `${keys.owners}:next` as const };
  await sysRedis.del([next.hats, next.owners]);
  for (const part of chunk(hats, 1000))
    await sysRedis.hSet(
      next.hats,
      Object.fromEntries(part.map((hat) => [cosmeticScoreKey(hat), JSON.stringify(hat)]))
    );
  for (const part of chunk([...owners], 1000))
    await sysRedis.hSet(
      next.owners,
      Object.fromEntries(part.map(([ownerId, fields]) => [String(ownerId), JSON.stringify(fields)]))
    );
  const multi = sysRedis.multi();
  if (hats.length) multi.rename(next.hats, keys.hats).rename(next.owners, keys.owners);
  else multi.del([keys.hats, keys.owners]);
  await multi.exec();
}

// Run by the hourly job right after the referee, from the primary: a lagging replica would freeze
// stale numbers into the snapshot until the next run.
export async function refreshStandings(event: StandingsEvent, db: typeof dbWrite | typeof dbRead) {
  const standings = await computeStandings(event, db);
  await writeHatTotals(event, await hatTotals(event, db));
  await sysRedis.packed.set(snapshotKeys(event).standings, standings);
  return standings;
}

const emptyStandings = (event: StandingsEvent): EventStandings => ({
  teams: event.teams.map((team, i) => ({ team, score: 0, rank: i + 1 })),
  history: event.teams.map((team) => ({ team, scores: [] })),
  topCosmetics: [],
  topUsers: {},
  updatedAt: new Date(0),
});

type StandingsRead = { onDegraded?: () => void };

// Before the job's first run, or while sysRedis is unreachable, every team shows zero. Neither is
// the real standings, so an edge-cached route is told not to keep it.
export async function getEventStandings(event: StandingsEvent, { onDegraded }: StandingsRead = {}) {
  try {
    const cached = await sysRedis.packed.get<EventStandings>(snapshotKeys(event).standings);
    if (cached) return cached;
  } catch (error) {
    logSysRedisFailOpen('read-degraded', 'getEventStandings', error, { event: event.name });
  }
  onDegraded?.();
  return emptyStandings(event);
}

export async function getTeamScoreHistory(event: StandingsEvent, read?: StandingsRead) {
  return (await getEventStandings(event, read)).history;
}

const parseScores = (values: (string | null | undefined)[]) =>
  values.flatMap((value) => (value ? [JSON.parse(value) as CosmeticScore] : []));

// A hat the job has not settled yet has no entry, and its per-type counts read as zero; so does
// every hat while sysRedis is unreachable.
export async function getUserCosmeticScores(
  event: StandingsEvent,
  userId: number,
  onDegraded?: () => void
) {
  const keys = snapshotKeys(event);
  try {
    const owned = await sysRedis.hGet(keys.owners, String(userId));
    const fields = JSON.parse(owned ?? '[]') as string[];
    if (!fields.length) return [];
    const scores = parseScores(await sysRedis.hmGet(keys.hats, fields));
    return scores.sort((a, b) => b.points - a.points);
  } catch (error) {
    logSysRedisFailOpen('read-degraded', 'getUserCosmeticScores', error, { event: event.name });
    onDegraded?.();
    return [];
  }
}

export async function getCosmeticScores(
  event: StandingsEvent,
  keys: CosmeticScoreKey[],
  onDegraded?: () => void
) {
  if (!keys.length) return {} as Record<string, CosmeticScore>;
  try {
    const scores = parseScores(
      await sysRedis.hmGet(snapshotKeys(event).hats, [...new Set(keys.map(cosmeticScoreKey))])
    );
    return Object.fromEntries(scores.map((s) => [cosmeticScoreKey(s), s]));
  } catch (error) {
    logSysRedisFailOpen('read-degraded', 'getCosmeticScores', error, { event: event.name });
    onDegraded?.();
    return {} as Record<string, CosmeticScore>;
  }
}
