import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CrucibleRow,
  EntryRow,
  JudgeRow,
  PairRow,
  TallyRow,
} from '$lib/server/crucible-judging.service';

type ChQuery = {
  query: string;
  query_params: Record<string, number>;
  clickhouse_settings: Record<string, number>;
};
const chQueries: ChQuery[] = [];
const ch: { judges: JudgeRow[]; tally: TallyRow[]; pairs: PairRow[] } = {
  judges: [],
  tally: [],
  pairs: [],
};
const tables: Record<string, unknown[]> = {};

vi.mock('$lib/server/db', () => {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      execute: async () => tables[table] ?? [],
      executeTakeFirst: async () => (tables[table] ?? [])[0],
    };
    return chain;
  };
  return { dbRead: { selectFrom: from } };
});
vi.mock('$lib/server/clickhouse', () => ({
  getClickhouse: () => ({
    query: async (q: ChQuery) => {
      chQueries.push(q);
      const rows = q.query.includes('ARRAY JOIN')
        ? ch.tally
        : q.query.includes('AS winnerEntryId')
        ? ch.pairs
        : ch.judges;
      return { json: async () => rows };
    },
  }),
}));
vi.mock('$lib/server/users.service', () => ({
  isInt4Id: (n: number) => Number.isInteger(n) && n > 0 && n <= 2147483647,
  usersByIds: async (ids: number[]) => new Map(ids.map((id) => [id, { username: `u${id}` }])),
}));

const svc = await import('$lib/server/crucible-judging.service');
const { getCrucibleJudging, assembleCrucibleJudging, judgesSql, tallySql, pairListSql } = svc;

const CRUCIBLE = 7;
const JUDGE = 900;
const crucible = (over: Partial<CrucibleRow> = {}): CrucibleRow => ({
  id: CRUCIBLE,
  name: 'C',
  userId: 1,
  status: 'Completed',
  startAt: null,
  endAt: null,
  takenDownAt: null,
  ...over,
});
const entry = (id: number, over: Partial<EntryRow> = {}): EntryRow => ({
  id,
  userId: 100 + id,
  imageId: 1000 + id,
  score: 1500,
  voteCount: 0,
  position: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  ...over,
});
const judgeRow = (judge: number, counted: number, over: Partial<JudgeRow> = {}): JudgeRow => ({
  judge: String(judge),
  votes: String(counted),
  counted: String(counted),
  conflicting: '0',
  firstAt: '2026-11-01 00:00:00',
  lastAt: '2026-11-02 00:00:00',
  ...over,
});
const tallyRow = (
  entryId: number,
  wins: number,
  losses: number,
  topJudges: [string, string, string][] = []
): TallyRow => ({
  entryId: String(entryId),
  wins: String(wins),
  losses: String(losses),
  judges: '1',
  topJudges,
});
const pairRow = (winner: number, loser: number): PairRow => ({
  winnerEntryId: String(winner),
  loserEntryId: String(loser),
  votes: '1',
  conflicting: 0,
  firstAt: '2026-11-01 00:00:00',
  lastAt: '2026-11-01 00:00:00',
});

const assemble = (over: Partial<Parameters<typeof assembleCrucibleJudging>[0]> = {}) =>
  assembleCrucibleJudging({
    crucible: crucible(),
    entries: [],
    versions: [],
    judges: [],
    tally: [],
    pairs: null,
    judgeId: null,
    users: new Map(),
    ...over,
  });

beforeEach(() => {
  chQueries.length = 0;
  ch.judges = [];
  ch.tally = [];
  ch.pairs = [];
  for (const k of Object.keys(tables)) delete tables[k];
});

const squash = (s: string) => s.replace(/\s+/g, ' ');

describe('crucible_judging counts votes as scoring does', () => {
  // The scorer's own query, read from the main app so a change on either side shows here.
  const scorer = squash(
    readFileSync(
      fileURLToPath(
        new URL('../../../../../../src/server/services/crucible-bradley-terry.ts', import.meta.url)
      ),
      'utf8'
    )
  );
  const fetchJudgeVotes = scorer.slice(scorer.indexOf('async function fetchJudgeVotes'));
  const groupBy = /GROUP BY userId, least\([^)]*\), greatest\([^)]*\)/.exec(fetchJudgeVotes)?.[0];
  const pick = /any\(\(winnerEntryId, loserEntryId\)\)/.exec(fetchJudgeVotes)?.[0];

  it('finds the dedupe in the scorer', () => {
    expect(groupBy).toBe(
      'GROUP BY userId, least(winnerEntryId, loserEntryId), greatest(winnerEntryId, loserEntryId)'
    );
    expect(pick).toBe('any((winnerEntryId, loserEntryId))');
  });

  it.each([
    ['judges', judgesSql(false)],
    ['judges for one judge', judgesSql(true)],
    ['tallies', tallySql(false)],
    ['tallies for one judge', tallySql(true)],
    ['pairs', pairListSql],
  ])('dedupes the %s read the same way', (_, sql) => {
    expect(squash(sql)).toContain(groupBy!);
    expect(squash(sql)).toContain(pick!);
  });
});

describe('crucible_judging reads', () => {
  it('bounds every ClickHouse read by the crucible, a row limit and a time limit, with values bound', async () => {
    tables.Crucible = [crucible()];
    await getCrucibleJudging(CRUCIBLE);
    expect(chQueries).toHaveLength(2);
    for (const q of chQueries) {
      expect(q.query).toContain('crucibleId = {crucibleId:Int32}');
      expect(q.query).not.toContain('{judgeId');
      expect(q.query).toContain('LIMIT {limit:UInt32}');
      expect(q.query_params.crucibleId).toBe(CRUCIBLE);
      expect(q.query_params.limit).toBeGreaterThan(0);
      expect(q.clickhouse_settings.max_execution_time).toBe(30);
    }
  });

  it('scopes every read to the judge when one is asked for', async () => {
    tables.Crucible = [crucible()];
    await getCrucibleJudging(CRUCIBLE, JUDGE);
    expect(chQueries).toHaveLength(3);
    for (const q of chQueries) {
      expect(q.query).toContain('AND userId = {judgeId:Int32}');
      expect(q.query_params.judgeId).toBe(JUDGE);
    }
  });

  it('returns null for a crucible that does not exist, reading no votes', async () => {
    expect(await getCrucibleJudging(CRUCIBLE)).toBeNull();
    expect(chQueries).toHaveLength(0);
  });

  it('reads nothing for an id out of range', async () => {
    tables.Crucible = [crucible()];
    expect(await getCrucibleJudging(0)).toBeNull();
    expect(await getCrucibleJudging(CRUCIBLE, 2 ** 31)).toBeNull();
    expect(chQueries).toHaveLength(0);
  });
});

describe('crucible_judging for one judge', () => {
  it('tallies all of a judge’s votes when their pair list is cut short', async () => {
    tables.Crucible = [crucible()];
    tables.CrucibleEntry = [entry(1), entry(2)];
    ch.judges = [judgeRow(JUDGE, 600)];
    ch.tally = [tallyRow(1, 400, 200), tallyRow(2, 200, 400)];
    ch.pairs = Array.from({ length: 501 }, () => pairRow(1, 2));
    const out = (await getCrucibleJudging(CRUCIBLE, JUDGE))!;
    expect(out.entries.map((e) => [e.countedWins, e.countedLosses])).toEqual([
      [400, 200],
      [200, 400],
    ]);
    expect(out.pairs).toHaveLength(500);
    expect(out.truncated).toEqual({ entries: false, judges: false, pairs: true, tallies: false });
    expect(out.talliesFor).toBe(`judge ${JUDGE}`);
    expect(out.entries[0]).not.toHaveProperty('topJudges');
  });

  it('asks for one pair past the cap, so a cut list is seen as cut', async () => {
    tables.Crucible = [crucible()];
    await getCrucibleJudging(CRUCIBLE, JUDGE);
    const pairs = chQueries.find((q) => q.query.includes('AS winnerEntryId'))!;
    expect(pairs.query_params.limit).toBe(501);
  });
});

describe('crucible_judging output', () => {
  it('lists each entry with the model versions on its image, and none for a deleted image', () => {
    const out = assemble({
      entries: [entry(1), entry(2, { imageId: null })],
      versions: [
        { imageId: 1001, modelVersionId: 55 },
        { imageId: 1001, modelVersionId: 56 },
      ],
    });
    expect(out.entries.map((e) => [e.entryId, e.imageId, e.modelVersionIds])).toEqual([
      [1, 1001, [55, 56]],
      [2, null, []],
    ]);
  });

  it('carries submission time, owner and stored standing on each entry', () => {
    const at = new Date('2026-10-30T12:00:00Z');
    const out = assemble({
      entries: [entry(1, { createdAt: at, score: 1620, position: 2, voteCount: 40 })],
      users: new Map([[101, { username: 'owner' }]]),
    });
    expect(out.entries[0]).toMatchObject({
      ownerId: 101,
      ownerName: 'owner',
      submittedAt: at,
      score: 1620,
      position: 2,
      voteCount: 40,
    });
  });

  it('names the judges who gave an entry most of its wins', () => {
    const out = assemble({
      entries: [entry(1)],
      tally: [tallyRow(1, 12, 3, [['900', '9', '1']])],
      users: new Map([[900, { username: 'j' }]]),
    });
    expect(out.entries[0].topJudges).toEqual([{ judgeId: 900, username: 'j', wins: 9, losses: 1 }]);
  });

  it('reports each judge’s raw, counted and conflicting votes', () => {
    const out = assemble({
      judges: [judgeRow(JUDGE, 240, { votes: '251', conflicting: '3' })],
    });
    expect(out.judges[0]).toMatchObject({
      judgeId: JUDGE,
      votes: 251,
      countedVotes: 240,
      conflictingPairs: 3,
    });
  });

  it('warns that scores are hidden from the public only while the crucible runs', () => {
    expect(assemble({ crucible: crucible({ status: 'Active' }) }).notes).toContain(
      svc.NOTES.hiddenWhileRunning
    );
    expect(assemble().notes).not.toContain(svc.NOTES.hiddenWhileRunning);
    expect(assemble().notes).toContain(svc.NOTES.noJudgeRanking);
    expect(assemble().notes).toContain(svc.NOTES.counted);
  });

  it('keeps tallies for entries it does not list', () => {
    const out = assemble({ entries: [entry(1)], tally: [tallyRow(1, 1, 0), tallyRow(9, 0, 1)] });
    expect(out.unlistedEntryTallies).toEqual([{ entryId: 9, wins: 0, losses: 1 }]);
  });

  it('cuts entries and judges at their caps and says so', () => {
    const entries = Array.from({ length: svc.ENTRY_LIMIT + 1 }, (_, i) => entry(i + 1));
    const judges = Array.from({ length: svc.JUDGE_LIMIT + 1 }, (_, i) => judgeRow(i + 1, 1));
    const out = assemble({ entries, judges });
    expect(out.entries).toHaveLength(svc.ENTRY_LIMIT);
    expect(out.judges).toHaveLength(svc.JUDGE_LIMIT);
    expect(out.truncated).toMatchObject({ entries: true, judges: true, pairs: false });
    const exact = assemble({ entries: entries.slice(1), judges: judges.slice(1) });
    expect(exact.truncated).toMatchObject({ entries: false, judges: false });
  });

  it('says the tallies were cut when the tally read hits its limit', () => {
    const tally = Array.from({ length: svc.TALLY_LIMIT }, (_, i) => tallyRow(i + 1, 1, 0));
    expect(assemble({ tally }).truncated.tallies).toBe(true);
    expect(assemble({ tally: tally.slice(1) }).truncated.tallies).toBe(false);
  });
});
