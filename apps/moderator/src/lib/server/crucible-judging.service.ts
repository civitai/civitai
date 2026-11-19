import { getClickhouse } from './clickhouse';
import { dbRead } from './db';
import { isInt4Id, usersByIds } from './users.service';

// Who judged a crucible and how. Judges never score an entry: each vote picks one of two entries, and
// the ranking is fitted across every judge's votes. So per judge there are votes and win/loss tallies,
// never a per-judge score or ranking.

export const ENTRY_LIMIT = 1000;
/** The largest crucible had 331 judges on 2026-11-06. */
export const JUDGE_LIMIT = 500;
export const PAIR_LIMIT = 500;
/** Every listed entry can carry a tally, plus entries no longer in the crucible. */
export const TALLY_LIMIT = 2 * ENTRY_LIMIT;
const TOP_JUDGES_PER_ENTRY = 3;
const VERSIONS_PER_IMAGE = 20;
const READ_TIMEOUT_S = 30;

/**
 * One row per judge per pair of entries: the vote that counts, as scoring counts it. Keep the GROUP BY
 * and the any() in step with fetchJudgeVotes (src/server/services/crucible-bradley-terry.ts); a test
 * compares them.
 */
const pairsSql = (byJudge: boolean) => `
  WITH pairs AS (
    SELECT userId AS judge,
           any((winnerEntryId, loserEntryId)) AS p,
           count() AS votes,
           uniqExact(winnerEntryId) AS sides,
           min(createdAt) AS firstAt,
           max(createdAt) AS lastAt
    FROM default.crucible_votes
    WHERE crucibleId = {crucibleId:Int32}${byJudge ? ' AND userId = {judgeId:Int32}' : ''}
    GROUP BY userId, least(winnerEntryId, loserEntryId), greatest(winnerEntryId, loserEntryId)
  )`;

export const judgesSql = (byJudge: boolean) => `${pairsSql(byJudge)}
  SELECT judge, sum(votes) AS votes, count() AS counted, countIf(sides > 1) AS conflicting,
         min(firstAt) AS firstAt, max(lastAt) AS lastAt
  FROM pairs
  GROUP BY judge
  ORDER BY counted DESC, judge
  LIMIT {limit:UInt32}`;

/** Wins and losses per entry over every counted vote in scope, never over the capped pair list. */
export const tallySql = (byJudge: boolean) => `${pairsSql(byJudge)}
  SELECT entryId, sum(w) AS wins, sum(l) AS losses, count() AS judges,
         arraySlice(arrayReverseSort(x -> x.2, groupArray((judge, w, l))), 1, ${TOP_JUDGES_PER_ENTRY}) AS topJudges
  FROM (
    SELECT judge, entryId, sum(won) AS w, count() - sum(won) AS l
    FROM pairs
    ARRAY JOIN [p.1, p.2] AS entryId, [1, 0] AS won
    GROUP BY judge, entryId
  )
  GROUP BY entryId
  ORDER BY wins DESC, entryId
  LIMIT {limit:UInt32}`;

export const pairListSql = `${pairsSql(true)}
  SELECT p.1 AS winnerEntryId, p.2 AS loserEntryId, votes, sides > 1 AS conflicting, firstAt, lastAt
  FROM pairs
  ORDER BY firstAt, winnerEntryId, loserEntryId
  LIMIT {limit:UInt32}`;

export type JudgeRow = {
  judge: string;
  votes: string;
  counted: string;
  conflicting: string;
  firstAt: string;
  lastAt: string;
};
export type TallyRow = {
  entryId: string;
  wins: string;
  losses: string;
  judges: string;
  topJudges: [string, string, string][];
};
export type PairRow = {
  winnerEntryId: string;
  loserEntryId: string;
  votes: string;
  conflicting: number;
  firstAt: string;
  lastAt: string;
};

async function chRead<T>(query: string, params: Record<string, number>) {
  const result = await getClickhouse().query({
    query,
    query_params: params,
    format: 'JSONEachRow',
    clickhouse_settings: { max_execution_time: READ_TIMEOUT_S },
  });
  return result.json<T>();
}

export type CrucibleRow = {
  id: number;
  name: string;
  userId: number;
  status: string;
  startAt: Date | null;
  endAt: Date | null;
  takenDownAt: Date | null;
};
export type EntryRow = {
  id: number;
  userId: number;
  imageId: number | null;
  score: number;
  voteCount: number;
  position: number | null;
  createdAt: Date;
};

export const NOTES = {
  noJudgeRanking:
    'Judges never score or rank entries: each vote picks one of two entries, and the ranking is fitted across all judges. Per judge there are only votes and win/loss tallies.',
  hiddenWhileRunning:
    'While a crucible runs, its scores and positions are hidden from the public so they cannot bias judges. Do not repeat them to users before it ends.',
  scoreLag:
    'score, position and voteCount are the stored values, copied from the live rating every few minutes while the crucible runs, so they can trail it. Vote tallies come from the analytics copy of the votes, which can also trail the newest votes by minutes.',
  counted:
    'countedVotes counts one vote per judge per pair of entries, as scoring does; votes counts every click. A judge who voted a pair both ways (conflictingPairs) has one of the two picked arbitrarily, so tallies on those pairs can change between runs.',
  modelVersions:
    "modelVersionIds are the resources recorded on the entry's image, not on the entry.",
};

export type CrucibleJudging = Awaited<ReturnType<typeof assembleCrucibleJudging>>;

/** Joins the Postgres rows to the ClickHouse tallies. */
export function assembleCrucibleJudging(input: {
  crucible: CrucibleRow;
  entries: EntryRow[];
  versions: { imageId: number; modelVersionId: number }[];
  judges: JudgeRow[];
  tally: TallyRow[];
  pairs: PairRow[] | null;
  judgeId: number | null;
  users: Map<number, { username: string | null }>;
}) {
  const { crucible, judgeId, users } = input;
  const name = (id: number) => users.get(id)?.username ?? null;
  const versionsByImage = new Map<number, number[]>();
  for (const v of input.versions) {
    const list = versionsByImage.get(v.imageId) ?? [];
    if (list.length < VERSIONS_PER_IMAGE) list.push(v.modelVersionId);
    versionsByImage.set(v.imageId, list);
  }
  const tallyById = new Map(input.tally.map((t) => [Number(t.entryId), t]));
  const entries = input.entries.slice(0, ENTRY_LIMIT);
  const listed = new Set(entries.map((e) => e.id));
  const judges = input.judges.slice(0, JUDGE_LIMIT).map((j) => ({
    judgeId: Number(j.judge),
    username: name(Number(j.judge)),
    votes: Number(j.votes),
    countedVotes: Number(j.counted),
    conflictingPairs: Number(j.conflicting),
    firstVoteAt: j.firstAt,
    lastVoteAt: j.lastAt,
  }));
  const pairs = input.pairs?.slice(0, PAIR_LIMIT).map((p) => ({
    winnerEntryId: Number(p.winnerEntryId),
    loserEntryId: Number(p.loserEntryId),
    votes: Number(p.votes),
    conflicting: Boolean(Number(p.conflicting)),
    firstAt: p.firstAt,
    lastAt: p.lastAt,
  }));

  return {
    crucible: {
      id: crucible.id,
      name: crucible.name,
      ownerId: crucible.userId,
      ownerName: name(crucible.userId),
      status: crucible.status,
      startAt: crucible.startAt,
      endAt: crucible.endAt,
      takenDown: crucible.takenDownAt !== null,
      running: crucible.status === 'Active',
    },
    notes: [
      NOTES.noJudgeRanking,
      ...(crucible.status === 'Active' ? [NOTES.hiddenWhileRunning] : []),
      NOTES.scoreLag,
      NOTES.counted,
      NOTES.modelVersions,
    ],
    /** In a judge's view the tallies are that judge's alone. */
    talliesFor: judgeId === null ? 'all judges' : `judge ${judgeId}`,
    entries: entries.map((e) => {
      const t = tallyById.get(e.id);
      return {
        entryId: e.id,
        ownerId: e.userId,
        ownerName: name(e.userId),
        imageId: e.imageId,
        modelVersionIds: e.imageId === null ? [] : versionsByImage.get(e.imageId) ?? [],
        submittedAt: e.createdAt,
        score: e.score,
        position: e.position,
        voteCount: e.voteCount,
        countedWins: Number(t?.wins ?? 0),
        countedLosses: Number(t?.losses ?? 0),
        judges: Number(t?.judges ?? 0),
        ...(judgeId === null && {
          topJudges: (t?.topJudges ?? []).map(([id, wins, losses]) => ({
            judgeId: Number(id),
            username: name(Number(id)),
            wins: Number(wins),
            losses: Number(losses),
          })),
        }),
      };
    }),
    /** Voted-on entries missing from `entries`: past the entry cap, or no longer in the crucible. */
    unlistedEntryTallies: input.tally
      .filter((t) => !listed.has(Number(t.entryId)))
      .map((t) => ({ entryId: Number(t.entryId), wins: Number(t.wins), losses: Number(t.losses) })),
    judges,
    ...(pairs && { pairs }),
    truncated: {
      entries: input.entries.length > ENTRY_LIMIT,
      judges: input.judges.length > JUDGE_LIMIT,
      pairs: (input.pairs?.length ?? 0) > PAIR_LIMIT,
      tallies: input.tally.length >= TALLY_LIMIT,
    },
  };
}

/** Null when the crucible does not exist. */
export async function getCrucibleJudging(
  crucibleId: number,
  judgeId: number | null = null
): Promise<CrucibleJudging | null> {
  if (!isInt4Id(crucibleId) || (judgeId !== null && !isInt4Id(judgeId))) return null;
  const crucible = await dbRead
    .selectFrom('Crucible')
    .select(['id', 'name', 'userId', 'status', 'startAt', 'endAt', 'takenDownAt'])
    .where('id', '=', crucibleId)
    .executeTakeFirst();
  if (!crucible) return null;

  const byJudge = judgeId !== null;
  const params = { crucibleId, ...(byJudge && { judgeId }) };
  const [entries, judges, tally, pairs] = await Promise.all([
    dbRead
      .selectFrom('CrucibleEntry')
      .select(['id', 'userId', 'imageId', 'score', 'voteCount', 'position', 'createdAt'])
      .where('crucibleId', '=', crucibleId)
      .orderBy('position', (ob) => ob.asc().nullsLast())
      .orderBy('score', 'desc')
      .orderBy('id')
      .limit(ENTRY_LIMIT + 1)
      .execute(),
    chRead<JudgeRow>(judgesSql(byJudge), { ...params, limit: JUDGE_LIMIT + 1 }),
    chRead<TallyRow>(tallySql(byJudge), { ...params, limit: TALLY_LIMIT }),
    byJudge ? chRead<PairRow>(pairListSql, { ...params, limit: PAIR_LIMIT + 1 }) : null,
  ]);

  const imageIds = entries.flatMap((e) => (e.imageId === null ? [] : [e.imageId]));
  const [versions, users] = await Promise.all([
    imageIds.length
      ? dbRead
          .selectFrom('ImageResourceNew')
          .select(['imageId', 'modelVersionId'])
          .where('imageId', 'in', imageIds)
          .execute()
      : [],
    usersByIds([
      crucible.userId,
      ...entries.map((e) => e.userId),
      ...judges.map((j) => Number(j.judge)),
      ...tally.flatMap((t) => t.topJudges.map(([id]) => Number(id))),
    ]),
  ]);

  return assembleCrucibleJudging({
    crucible,
    entries,
    versions,
    judges,
    tally,
    pairs,
    judgeId,
    users,
  });
}
