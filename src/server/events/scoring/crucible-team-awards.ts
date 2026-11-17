import { Prisma } from '@prisma/client';
import { clickhouseLongQueries as clickhouse } from '~/server/clickhouse/client';
import { formatClickhouseDateTime64 } from '~/server/clickhouse/datetime';
import {
  clientAbortAfter,
  LONG_QUERY_PROGRESS_SETTINGS,
} from '~/server/events/points/clickhouse-limits';
import { dbRead, type dbWrite } from '~/server/db/client';
import type { TeamAward } from '~/server/events/base.event';
import { visibleEntryImageSql } from '~/server/services/crucible-entry-sql';
import { UserFlag } from '~/shared/constants/user-flags.constants';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

// Each crucible carrying `eventTag` gives the entrant's team `points` for each accepted entrant,
// once per person per crucible.
export const CRUCIBLE_TEAM_AWARDS = [
  { eventTag: 'birthday2026-rally', event: 'birthday2026', points: 1000 },
] as const;

// A ledger type no event's scoring config lists, so the hat referee never reads it.
export const CRUCIBLE_TEAM_AWARD_TYPE = 'crucibleTeamAward';

export type CrucibleTeamAwardRow = {
  time: string;
  op: 'add' | 'remove';
  actorId: number;
  entityId: number;
  team: string;
  sourceId: string;
};

export const crucibleAwardSourceId = (entryId: number) => `crucibleEntry:${entryId}`;
const entryIdOf = (sourceId: string) => Number(sourceId.slice('crucibleEntry:'.length));

/** A ledger row in `event_point_events`' shape: the entrant acting on the crucible. */
export const crucibleTeamAwardLedgerRow = (
  event: string,
  op: 'add' | 'remove',
  entry: { entryId: number; crucibleId: number; userId: number },
  time: Date,
  team = ''
) => ({
  event,
  time: formatClickhouseDateTime64(time),
  type: CRUCIBLE_TEAM_AWARD_TYPE,
  op,
  actorId: entry.userId,
  entityType: 'Crucible',
  entityId: entry.crucibleId,
  ownerId: 0,
  cosmeticId: 0,
  claimKey: '',
  team,
  sourceId: crucibleAwardSourceId(entry.entryId),
  players: [] as number[],
});

const opRank = { add: 0, remove: 1 } as const;
const parseTime = (time: string) => new Date(`${time.replace(' ', 'T')}Z`);

/**
 * The entries whose award still stands at `until`, from the ledger alone: an entry counts while its
 * latest row is an add, at its earliest add before `until`. A remove at any time takes it back; a
 * later add (re-accepted after a revoke) brings it back.
 */
export function standingCrucibleAwards(rows: readonly CrucibleTeamAwardRow[], until: Date) {
  const bySource = new Map<string, CrucibleTeamAwardRow[]>();
  for (const row of rows) {
    const list = bySource.get(row.sourceId) ?? [];
    list.push(row);
    bySource.set(row.sourceId, list);
  }
  const standing: {
    entryId: number;
    userId: number;
    crucibleId: number;
    team: string;
    at: Date;
  }[] = [];
  for (const [sourceId, list] of bySource) {
    const counted = list
      .map((row) => ({ ...row, at: parseTime(row.time) }))
      .filter((row) => row.op === 'remove' || row.at < until)
      // A remove and an add at the same instant: the remove wins, as a revoke follows its accept.
      .sort((a, b) => a.at.getTime() - b.at.getTime() || opRank[a.op] - opRank[b.op]);
    if (counted.at(-1)?.op !== 'add') continue;
    const first = counted.find((row) => row.op === 'add');
    if (!first) continue;
    standing.push({
      entryId: entryIdOf(sourceId),
      userId: first.actorId,
      crucibleId: first.entityId,
      team: first.team,
      at: first.at,
    });
  }
  return standing;
}

/**
 * One award per (entrant, crucible): the earliest standing entry among those `counted` allows, so
 * a second entry keeps the award when the first leaves.
 */
export function crucibleAwardsFrom(
  standing: ReturnType<typeof standingCrucibleAwards>,
  counted: ReadonlySet<number>,
  points: number
): TeamAward[] {
  const first = new Map<string, (typeof standing)[number]>();
  for (const award of standing) {
    if (!counted.has(award.entryId)) continue;
    const key = `${award.userId}:${award.crucibleId}`;
    const held = first.get(key);
    if (!held || award.at < held.at) first.set(key, award);
  }
  return [...first.values()].map(({ team, at, crucibleId }) => ({
    team,
    points,
    at,
    reason: `Crucible ${crucibleId} entrant`,
  }));
}

// Runs under the settle lock, so it has its own cap.
export const CRUCIBLE_AWARD_QUERY_MAX_S = 2 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (time: Date) => time.toISOString().slice(0, 10);

// Every UTC day an award row can sit on: the season's first through the later of now and `until`.
export function crucibleAwardDays(seasonStart: Date, until: Date, now = new Date()) {
  const last = Math.max(now.getTime(), until.getTime());
  const days: string[] = [];
  for (let t = Date.parse(utcDay(seasonStart)); t <= last; t += DAY_MS)
    days.push(utcDay(new Date(t)));
  return days;
}

const AWARD_ROWS_TAG = '-- crucible team award rows';
export const isCrucibleTeamAwardRowsSql = (sql: string) => sql.startsWith(AWARD_ROWS_TAG);

// One scan per day. The ledger is ordered by (event, toDate(time), ownerId, ...) and award rows are
// all written with ownerId 0 (crucibleTeamAwardLedgerRow), so an exact day lets the key use ownerId
// too and read a few granules; a range of days, or a set of them, cannot, and reads the season.
export function crucibleTeamAwardRowsSql(days: number) {
  const scans = Array.from(
    { length: days },
    (_, i) => /* sql */ `SELECT time, op, actorId, entityId, team, sourceId
FROM event_point_events
WHERE event = {event:String}
  AND toDate(time) = {day${i}:Date}
  AND ownerId = 0
  AND type = {type:String}
  AND time >= {seasonStart:DateTime64(3)}`
  );
  return `${AWARD_ROWS_TAG}\n${scans.join('\nUNION ALL\n')}\n`;
}

/**
 * The entries that may still count: in their crucible, the crucible not cancelled, the image one
 * judges can see, and the entrant not banned, deleted or excluded from leaderboards. Read now, so an
 * entry hidden after its accept (a ToS flag, a review hold, an unpublished post, a re-rating) stops
 * counting at the next read with nothing revoking it, and counts again once it is shown.
 */
async function countedEntryIds(entryIds: number[], db: typeof dbRead | typeof dbWrite) {
  if (!entryIds.length) return new Set<number>();
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT ce.id
    FROM "CrucibleEntry" ce
    JOIN "Crucible" c ON c.id = ce."crucibleId"
    JOIN "Image" i ON i.id = ce."imageId"
    JOIN "User" u ON u.id = ce."userId"
    WHERE ce.id = ANY(${entryIds}::int[])
      AND c.status <> ${CrucibleStatus.Cancelled}::"CrucibleStatus"
      AND ${visibleEntryImageSql(Prisma.sql`c."nsfwLevel"`, 0)}
      AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL
      AND (u.flags & ${UserFlag.ExcludeFromEventPoints}::int) = 0
  `;
  return new Set(rows.map((r) => r.id));
}

/** The crucible-entrant awards an event's teams hold by `until`. */
export async function loadCrucibleTeamAwards(
  event: { name: string; startDate: Date },
  until: Date,
  db: typeof dbRead | typeof dbWrite = dbRead
): Promise<TeamAward[]> {
  const award = CRUCIBLE_TEAM_AWARDS.find((a) => a.event === event.name);
  // No ClickHouse, no ledger: the award writer skips its inserts the same way.
  if (!award || !clickhouse) return [];
  const days = crucibleAwardDays(event.startDate, until);
  // A preview read before the season's first day: no row can exist, and no scan would be no query.
  if (!days.length) return [];
  const result = await clickhouse.query({
    query: crucibleTeamAwardRowsSql(days.length),
    format: 'JSONEachRow',
    abort_signal: clientAbortAfter(CRUCIBLE_AWARD_QUERY_MAX_S),
    clickhouse_settings: {
      max_execution_time: CRUCIBLE_AWARD_QUERY_MAX_S,
      ...LONG_QUERY_PROGRESS_SETTINGS,
    },
    query_params: {
      event: event.name,
      type: CRUCIBLE_TEAM_AWARD_TYPE,
      seasonStart: formatClickhouseDateTime64(event.startDate),
      ...Object.fromEntries(days.map((day, i) => [`day${i}`, day])),
    },
  });
  const standing = standingCrucibleAwards(await result.json<CrucibleTeamAwardRow>(), until);
  const counted = await countedEntryIds(
    standing.map((s) => s.entryId),
    db
  );
  return crucibleAwardsFrom(standing, counted, award.points);
}
