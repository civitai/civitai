import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';
import type * as EloService from '~/server/services/crucible-elo.service';
import { dbMock, redisMock } from '~/__tests__/mocks';
import { JUDGE_SKIP_LIST_LIMIT, judgeSkipListReducer } from '~/components/Crucible/judge-skip-list';
import { CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY } from '~/shared/constants/crucible.constants';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md. Declare behaviour, never
// re-mock the specifier.
const findUnique = dbMock.dbRead.crucible.findUnique;
const queryRaw = dbMock.dbRead.$queryRaw;
const hGetAll = redisMock.sysRedis.hGetAll;
const sMembers = redisMock.sysRedis.sMembers;
const getAllEntryElos = vi.fn();

vi.mock('~/server/services/crucible-elo.service', async (importOriginal) => ({
  ...(await importOriginal<typeof EloService>()),
  getAllEntryElos,
}));

const { getJudgingPair } = await import('~/server/services/crucible.service');

const activeCrucible = {
  id: 1,
  status: CrucibleStatus.Active,
  endAt: new Date(Date.now() + 60 * 60 * 1000),
  userId: 999,
  buzzType: 'yellow',
  nsfwLevel: 31,
  ingestion: CrucibleIngestionStatus.Scanned,
  image: { ingestion: ImageIngestionStatus.Scanned },
};

/** Shape `fetchEntrySample`'s raw SQL projection returns, before it maps to EntryForJudging. */
const rawEntry = (id: number, userId: number, score = 1500) => ({
  id,
  imageId: id * 10,
  userId,
  score,
  image_id: id * 10,
  image_url: `image-${id}`,
  image_width: 512,
  image_height: 512,
  image_nsfwLevel: 1,
  user_id: userId,
  user_username: `user${userId}`,
  user_deletedAt: null,
  user_image: null,
});

const asHash = (counts: Record<number, number>) =>
  Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, String(n)]));

/**
 * Each entry's vote count across all judges, where `crucibleEloRedis.getAllVoteCounts` reads it,
 * and optionally this judge's own votes per entry. Read on every call, so a test may mutate them.
 */
const withVoteCounts = (
  counts: Record<number, number>,
  { judge = {} }: { judge?: Record<number, number> } = {}
) =>
  hGetAll.mockImplementation(async (key: string) =>
    key.endsWith(':votes') ? asHash(counts) : asHash(judge)
  );

/** Pairs this judge has already voted on. */
const withVotedPairs = (...pairs: [number, number][]) =>
  sMembers.mockResolvedValue(pairs.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));

const pairIds = (pair: Awaited<ReturnType<typeof getJudgingPair>>) =>
  pair ? [pair.left.id, pair.right.id].sort((a, b) => a - b) : null;

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(activeCrucible);
  getAllEntryElos.mockResolvedValue({});
  hGetAll.mockResolvedValue({});
  sMembers.mockResolvedValue([]);
});

describe('getJudgingPair — crucible state', () => {
  it('throws when the crucible does not exist', async () => {
    findUnique.mockResolvedValue(null);
    await expect(getJudgingPair({ crucibleId: 404, userId: 1 })).rejects.toThrow();
  });

  it.each([CrucibleStatus.Pending, CrucibleStatus.Completed, CrucibleStatus.Cancelled])(
    'refuses to serve a pair for a %s crucible',
    async (status) => {
      findUnique.mockResolvedValue({ ...activeCrucible, status });
      await expect(getJudgingPair({ crucibleId: 1, userId: 1 })).rejects.toThrow();
    }
  );

  it('is not found for a judge the creator blocked, unless a moderator', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99), rawEntry(2, 98)]);
    const blockedByUserIds = [activeCrucible.userId];

    await expect(getJudgingPair({ crucibleId: 1, userId: 1, blockedByUserIds })).rejects.toThrow(
      'Crucible not found'
    );
    await expect(
      getJudgingPair({ crucibleId: 1, userId: 1, blockedByUserIds, isModerator: true })
    ).resolves.not.toBeNull();
  });

  it('refuses once the end time has passed, even while still marked Active', async () => {
    findUnique.mockResolvedValue({
      ...activeCrucible,
      endAt: new Date(Date.now() - 1000),
    });
    await expect(getJudgingPair({ crucibleId: 1, userId: 1 })).rejects.toThrow();
  });
});

describe('getJudgingPair — pair selection', () => {
  it('returns null when fewer than two entries are available to this judge', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99)]);
    expect(await getJudgingPair({ crucibleId: 1, userId: 1 })).toBeNull();
  });

  it('returns null when the crucible has no entries at all', async () => {
    queryRaw.mockResolvedValue([]);
    expect(await getJudgingPair({ crucibleId: 1, userId: 1 })).toBeNull();
  });

  it('returns two distinct entries, neither belonging to the judge', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99), rawEntry(2, 98), rawEntry(3, 97)]);

    const pair = await getJudgingPair({ crucibleId: 1, userId: 1 });

    expect(pair).not.toBeNull();
    expect(pair!.left.id).not.toBe(pair!.right.id);
    expect(pair!.left.userId).not.toBe(1);
    expect(pair!.right.userId).not.toBe(1);
  });

  it('prefers the Redis ELO over the database score when both exist', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99, 1500), rawEntry(2, 98, 1500)]);
    getAllEntryElos.mockResolvedValue({ 1: 1700, 2: 1300 });

    const pair = await getJudgingPair({ crucibleId: 1, userId: 1 });
    const scores = [pair!.left.score, pair!.right.score].sort((a, b) => a - b);

    expect(scores).toEqual([1300, 1700]);
  });

  it('falls back to the database score for an entry Redis has not seen', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99, 1610), rawEntry(2, 98, 1390)]);
    getAllEntryElos.mockResolvedValue({ 1: 1700 });

    const pair = await getJudgingPair({ crucibleId: 1, userId: 1 });
    const scores = [pair!.left.score, pair!.right.score].sort((a, b) => a - b);

    expect(scores).toEqual([1390, 1700]);
  });
});

describe('getJudgingPair — already-voted pairs', () => {
  it('never serves a pair this judge has already voted on', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99), rawEntry(2, 98), rawEntry(3, 97)]);
    withVotedPairs([1, 2]);

    for (let i = 0; i < 20; i++) {
      expect(pairIds(await getJudgingPair({ crucibleId: 1, userId: 1 }))).not.toEqual([1, 2]);
    }
    expect(sMembers).toHaveBeenCalledWith(expect.stringMatching(/:1:1$/));
  });

  it('returns null after ONE query when a short sample holds every entry and all are judged', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99), rawEntry(2, 98), rawEntry(3, 97)]);
    withVotedPairs([1, 2], [1, 3], [2, 3]);

    expect(await getJudgingPair({ crucibleId: 1, userId: 1 })).toBeNull();
    // Fewer rows than the sample size means the sample was the whole crucible; drawing again
    // returns the same rows.
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('gives up after a bounded number of full samples when every pair in them is judged', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1);
    const full = ids.map((id) => rawEntry(id, 1000 + id));
    // Ends with a short sample after 50 calls, so dropping the attempt cap fails on the count
    // below instead of hanging the runner.
    queryRaw.mockImplementation(async () => (queryRaw.mock.calls.length > 50 ? [] : full));
    withVotedPairs(
      ...ids.flatMap((a) => ids.filter((b) => b > a).map((b) => [a, b] as [number, number]))
    );

    expect(await getJudgingPair({ crucibleId: 1, userId: 1 })).toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });
});

describe('getJudgingPair — pairing', () => {
  it('puts the least-voted entry in every pair, even when its rating has moved off 1500', async () => {
    queryRaw.mockResolvedValue([
      rawEntry(1, 11, 1500),
      rawEntry(2, 12, 1500),
      rawEntry(3, 13, 1500),
      rawEntry(4, 14, 1600),
      rawEntry(5, 15, 1540),
    ]);
    withVoteCounts({ 1: 9, 2: 9, 3: 9, 4: 9, 5: 0 });

    for (let i = 0; i < 20; i++) {
      const ids = pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }));
      expect(ids, 'entry 5 has no votes, so it must be in the pair').toContain(5);
    }
  });

  it('anchors on the entry this judge has voted on least, ahead of the least-voted overall', async () => {
    queryRaw.mockResolvedValue([
      rawEntry(1, 11),
      rawEntry(2, 12),
      rawEntry(3, 13),
      rawEntry(4, 14),
      rawEntry(5, 15),
    ]);
    // Entry 1 is the least-voted overall, but this judge just saw it in two pairs in a row.
    withVoteCounts({ 1: 2, 2: 9, 3: 9, 4: 9, 5: 9 }, { judge: { 1: 2, 2: 1, 3: 1 } });
    withVotedPairs([1, 2], [1, 3]);

    for (let i = 0; i < 20; i++) {
      const ids = pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }));
      expect(ids, 'the judge has not seen 4 or 5 yet').toEqual([4, 5]);
    }
  });

  it('does not put one entry in every pair as a judge votes through the crucible', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => rawEntry(i + 1, 11 + i));
    queryRaw.mockResolvedValue(entries);
    // A late entry: least-voted overall by a wide margin, so it stays least-voted all session.
    const global: Record<number, number> = {
      1: 0,
      2: 40,
      3: 40,
      4: 40,
      5: 40,
      6: 40,
      7: 40,
      8: 40,
    };
    const judge: Record<number, number> = {};
    const voted: [number, number][] = [];
    withVoteCounts(global, { judge });
    sMembers.mockImplementation(async () =>
      voted.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`)
    );

    let streak = 0;
    let longest = 0;
    let served = 0;
    for (let i = 0; i < 4; i++) {
      const ids = pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }));
      if (!ids) break;
      served++;
      streak = ids.includes(1) ? streak + 1 : 0;
      longest = Math.max(longest, streak);
      voted.push([ids[0], ids[1]]);
      for (const id of ids) {
        judge[id] = (judge[id] ?? 0) + 1;
        global[id] += 1;
      }
    }

    expect(served).toBe(4);
    expect(longest, 'entry 1 anchored consecutive pairs').toBeLessThan(2);
  });

  it('opposes it with the nearest-rated opponent', async () => {
    queryRaw.mockResolvedValue([
      rawEntry(1, 11, 1500),
      rawEntry(2, 12, 1700),
      rawEntry(3, 13, 1510),
      rawEntry(4, 14, 1300),
      rawEntry(5, 15, 1400),
    ]);
    withVoteCounts({ 1: 0, 2: 3, 3: 3, 4: 3, 5: 3 });

    for (let i = 0; i < 20; i++) {
      expect(pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }))).toEqual([1, 3]);
    }
  });

  it('takes the opponent from the least-voted candidates, not the nearest in the whole field', async () => {
    // Entry 2 is the nearest rating to entry 1 but has far more votes than the ten others.
    const others = Array.from({ length: 11 }, (_, i) => i + 3);
    queryRaw.mockResolvedValue([
      rawEntry(1, 11, 1500),
      rawEntry(2, 12, 1500),
      ...others.map((id) => rawEntry(id, 10 + id, 1700 + id)),
    ]);
    withVoteCounts({ 1: 0, 2: 50, ...Object.fromEntries(others.map((id) => [id, 1])) });

    for (let i = 0; i < 20; i++) {
      const ids = pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }));
      expect(ids).toContain(1);
      expect(ids).not.toContain(2);
    }
  });

  it('falls back to any unjudged pair once the least-voted entries are exhausted', async () => {
    queryRaw.mockResolvedValue([
      rawEntry(1, 11, 1500),
      rawEntry(2, 12, 1500),
      rawEntry(3, 13, 1700),
      rawEntry(4, 14, 1700),
    ]);
    withVoteCounts({ 1: 0, 2: 0, 3: 5, 4: 5 });
    withVotedPairs([1, 2], [1, 3], [1, 4], [2, 3], [2, 4]);

    expect(pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }))).toEqual([3, 4]);
  });

  it('brings skipped entries back instead of ending the session', async () => {
    const all = [rawEntry(1, 11), rawEntry(2, 12), rawEntry(3, 13)];
    queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('').includes('NOT IN') ? all.filter((e) => e.id === 3) : all
    );

    const pair = await getJudgingPair({ crucibleId: 1, userId: 7, skippedPairs: [[1, 2]] });

    expect(pair, 'three unjudged pairs were left, only behind the skip list').not.toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  // A skip has to outlive the next vote. Pairing is near-deterministic, so clearing the skip list on
  // a vote served the skipped pair straight back, every time (reported on the Crucibles article).
  it('does not serve a skipped pair again after the judge votes on the next one', async () => {
    const all = [
      rawEntry(1, 11, 1500),
      rawEntry(2, 12, 1500),
      rawEntry(3, 13, 1700),
      rawEntry(4, 14, 1700),
      rawEntry(5, 15, 1900),
      rawEntry(6, 16, 1900),
    ];
    queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const at = strings.findIndex((part) => part.trimEnd().endsWith('NOT IN ('));
      if (at === -1) return all;
      const excluded = (values[at] as { values: unknown[] }).values;
      return all.filter((e) => !excluded.includes(e.id));
    });
    withVoteCounts({ 1: 0, 2: 0, 3: 5, 4: 5, 5: 8, 6: 8 });
    const serve = async (skipped: [number, number][]) => {
      const pair = await getJudgingPair({
        crucibleId: 1,
        userId: 7,
        skippedPairs: skipped.length ? skipped : undefined,
      });
      if (!pair) throw new Error('no pair served');
      return pair;
    };

    let skipped: [number, number][] = [];
    const skippedPair = await serve(skipped);
    expect(pairIds(skippedPair)).toEqual([1, 2]);
    skipped = judgeSkipListReducer(skipped, { type: 'skip', pair: skippedPair });

    const votedPair = await serve(skipped);
    expect(pairIds(votedPair)).toEqual([3, 4]);
    withVotedPairs([3, 4]);
    withVoteCounts({ 1: 0, 2: 0, 3: 6, 4: 6, 5: 8, 6: 8 });
    skipped = judgeSkipListReducer(skipped, { type: 'vote', pair: votedPair });

    const next = pairIds(await serve(skipped))!;
    expect(
      next.filter((id) => [1, 2].includes(id)),
      'an entry the judge just skipped'
    ).toEqual([]);
  });

  // Reported on a crucible of 11 entries: after ~5 skips every entry was on the skip list, the
  // fallback dropped all of it, and near-deterministic pairing served the pair just skipped forever.
  it('keeps serving new pairs once the skip list covers every entry of a small crucible', async () => {
    const all = Array.from({ length: 11 }, (_, i) => rawEntry(i + 1, 100 + i, 1500));
    queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const at = strings.findIndex((part) => part.trimEnd().endsWith('NOT IN ('));
      if (at === -1) return all;
      const excluded = (values[at] as { values: unknown[] }).values;
      return all.filter((e) => !excluded.includes(e.id));
    });

    let skipped: [number, number][] = [];
    const served: string[] = [];
    for (let i = 0; i < 30; i++) {
      const pair = await getJudgingPair({
        crucibleId: 1,
        userId: 7,
        skippedPairs: skipped.length ? skipped : undefined,
      });
      if (!pair) throw new Error('no pair served');
      const key = pairIds(pair)!.join(':');
      expect(served.at(-1), `skip ${i} re-served the pair just skipped`).not.toBe(key);
      served.push(key);
      skipped = judgeSkipListReducer(skipped, { type: 'skip', pair });
    }

    expect(
      served.slice(-JUDGE_SKIP_LIST_LIMIT).every((key, i, recent) => recent.indexOf(key) === i),
      'a pair came back while fewer skips than the list holds had passed'
    ).toBe(true);
  });

  it('reads the entry list older clients send', async () => {
    const all = [rawEntry(1, 11), rawEntry(2, 12), rawEntry(3, 13)];
    queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('').includes('NOT IN') ? all.filter((e) => e.id === 3) : all
    );

    expect(
      await getJudgingPair({ crucibleId: 1, userId: 7, excludeEntryIds: [1, 2] })
    ).not.toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('does not query again when nothing was skipped', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 11)]);

    expect(await getJudgingPair({ crucibleId: 1, userId: 7 })).toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('getJudgingPair — same-author pairs', () => {
  it('never pairs two entries by one author while a cross-author pair exists', async () => {
    // Entries 1 and 2 are the least-voted and level on rating, so without the author rule they are
    // always the pair.
    queryRaw.mockResolvedValue([
      rawEntry(1, 50, 1500),
      rawEntry(2, 50, 1500),
      rawEntry(3, 60, 1800),
    ]);
    withVoteCounts({ 1: 0, 2: 0, 3: 9 });

    for (let i = 0; i < 20; i++) {
      const pair = await getJudgingPair({ crucibleId: 1, userId: 7 });
      expect(pair!.left.userId, `served ${pairIds(pair)}`).not.toBe(pair!.right.userId);
    }
  });

  it('serves a same-author pair once nothing else is left for this judge', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 50), rawEntry(2, 50), rawEntry(3, 60)]);
    withVotedPairs([1, 3], [2, 3]);

    expect(pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }))).toEqual([1, 2]);
  });

  it('keeps sampling for a cross-author pair before settling for a same-author one', async () => {
    const oneAuthor = Array.from({ length: 100 }, (_, i) => rawEntry(i + 1, 50));
    const mixed = [...oneAuthor.slice(0, 99), rawEntry(101, 60)];
    queryRaw.mockResolvedValue([]).mockResolvedValueOnce(oneAuthor).mockResolvedValueOnce(mixed);

    const pair = await getJudgingPair({ crucibleId: 1, userId: 7 });

    expect(pairIds(pair)).toContain(101);
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });

  it('settles for a same-author pair after a bounded number of full samples', async () => {
    const oneAuthor = Array.from({ length: 100 }, (_, i) => rawEntry(i + 1, 50));
    // Ends with a short sample after 50 calls, so dropping the attempt cap fails on the count
    // below instead of hanging the runner.
    queryRaw.mockImplementation(async () => (queryRaw.mock.calls.length > 50 ? [] : oneAuthor));

    const pair = await getJudgingPair({ crucibleId: 1, userId: 7 });

    expect(pair).not.toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  // A product decision, not an accident of ordering: when the only cross-author pairs left involve
  // an entry the judge just skipped, Skip wins over the author rule, because bringing the skipped
  // pair straight back makes the Skip button look dead. Do not reorder the fallback without asking.
  it('serves a same-author pair before bringing a skipped entry back', async () => {
    const all = [rawEntry(1, 50), rawEntry(2, 50), rawEntry(3, 60)];
    queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('').includes('NOT IN') ? all.filter((e) => e.id !== 3) : all
    );

    const pair = await getJudgingPair({ crucibleId: 1, userId: 7, excludeEntryIds: [3] });

    expect(pairIds(pair)).toEqual([1, 2]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('does not sample again without the skip list once a cross-author pair is found', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 50), rawEntry(3, 60)]);

    const pair = await getJudgingPair({ crucibleId: 1, userId: 7, excludeEntryIds: [9] });

    expect(pairIds(pair)).toEqual([1, 3]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('getJudgingPair — excludeEntryIds', () => {
  /** Flatten a `$queryRaw` call's interpolations, unwrapping the `Prisma.join(...)` Sql fragment. */
  const interpolatedValues = (call: unknown[]) =>
    call.slice(1).flatMap((value) => {
      const nested = (value as { values?: unknown[] })?.values;
      return Array.isArray(nested) ? nested : [value];
    });

  it('sends the caller exclusions into the sampling query', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99), rawEntry(2, 98)]);

    await getJudgingPair({ crucibleId: 1, userId: 1, excludeEntryIds: [7, 8] });

    // Exclusion happens in SQL, not in JS — if the ids never reach the query, a skipped entry
    // comes straight back and the whole Skip button is inert.
    expect(interpolatedValues(queryRaw.mock.calls[0])).toEqual(expect.arrayContaining([7, 8]));
  });

  it('takes the branch with no exclusion clause when the list is omitted', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99), rawEntry(2, 98)]);

    await getJudgingPair({ crucibleId: 1, userId: 1 });

    const sql = (queryRaw.mock.calls[0][0] as string[]).join('');
    expect(sql).not.toContain('NOT IN');
  });

  it('scopes the sample to this crucible and excludes the judge own entries in SQL', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99), rawEntry(2, 98)]);

    await getJudgingPair({ crucibleId: 42, userId: 7 });

    const sql = (queryRaw.mock.calls[0][0] as string[]).join('');
    expect(sql).toContain('"userId" != ');
    expect(interpolatedValues(queryRaw.mock.calls[0])).toEqual(expect.arrayContaining([42, 7]));
  });
});

describe('getJudgingPair — vote integrity', () => {
  it('records the pair it serves, so only a served pair can be voted', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 11), rawEntry(2, 12)]);

    const pair = await getJudgingPair({ crucibleId: 1, userId: 7 });

    expect(pair).not.toBeNull();
    expect(redisMock.sysRedis.set).toHaveBeenCalledWith(
      expect.stringMatching(/served-pair:1:7$/),
      '1:2',
      { EX: expect.any(Number) }
    );
  });

  it('serves an entry at the cap only against one the judge can still vote on', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 11), rawEntry(2, 12), rawEntry(3, 13)]);
    redisMock.sysRedis.hGetAll.mockResolvedValue({
      '1': String(CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY),
      '2': String(CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY),
    });

    for (let i = 0; i < 20; i++) {
      expect(pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }))).toContain(3);
    }
  });

  it('serves nothing once the judge has voted on every entry as often as allowed', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 11), rawEntry(2, 12), rawEntry(3, 13)]);
    const capped = String(CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY);
    redisMock.sysRedis.hGetAll.mockResolvedValue({ '1': capped, '2': capped, '3': capped });

    expect(await getJudgingPair({ crucibleId: 1, userId: 7 })).toBeNull();
  });
});

describe('getJudgingPair — anchors', () => {
  const capped = String(CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY);
  const servedValue = () => redisMock.sysRedis.set.mock.calls.at(-1)?.[1];
  const withRandom = (value: number) => vi.spyOn(Math, 'random').mockReturnValue(value);

  afterEach(() => vi.restoreAllMocks());

  // Entries 1 and 2 are anchors; 3 and 4 are open. Entry 3 is drawn first, so its opponents are
  // one open entry and two anchors: an anchor with probability 2/3.
  const fourEntries = () => {
    queryRaw.mockResolvedValue([
      rawEntry(1, 11),
      rawEntry(2, 12),
      rawEntry(3, 13),
      rawEntry(4, 14),
    ]);
    hGetAll.mockResolvedValue({ '1': capped, '2': capped });
  };

  it('picks an anchor in proportion to how many of the opponents are anchors', async () => {
    fourEntries();

    withRandom(0.66);
    const anchored = await getJudgingPair({ crucibleId: 1, userId: 7 });
    expect(pairIds(anchored), 'just under 2/3').toEqual([1, 3]);
    expect(servedValue(), 'the served pair names its anchor').toBe('1:3|anchor:1');

    withRandom(0.67);
    const open = await getJudgingPair({ crucibleId: 1, userId: 7 });
    expect(pairIds(open), 'just over 2/3').toEqual([3, 4]);
    expect(servedValue(), 'an open pair names no anchor').toBe('3:4');
  });

  it('never pairs two anchors, however the draw falls', async () => {
    fourEntries();

    for (const value of [0, 0.5, 0.999]) {
      withRandom(value);
      const ids = pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }));
      expect(ids?.filter((id) => id <= 2).length, `anchors in the pair at ${value}`).toBeLessThan(
        2
      );
    }
  });

  it('prefers an anchor by another author, and falls back to the same author', async () => {
    withRandom(0);
    queryRaw.mockResolvedValue([rawEntry(1, 50), rawEntry(2, 60), rawEntry(3, 50)]);
    hGetAll.mockResolvedValue({ '1': capped, '2': capped });
    expect(pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }))).toEqual([2, 3]);

    queryRaw.mockResolvedValue([rawEntry(1, 50), rawEntry(3, 50)]);
    hGetAll.mockResolvedValue({ '1': capped });
    expect(pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }))).toEqual([1, 3]);
  });

  it('does not serve an anchor pair the judge has already voted', async () => {
    withRandom(0);
    queryRaw.mockResolvedValue([rawEntry(1, 11), rawEntry(2, 12), rawEntry(3, 13)]);
    hGetAll.mockResolvedValue({ '1': capped, '2': capped });
    withVotedPairs([1, 3]);

    expect(pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }))).toEqual([2, 3]);
  });
});

describe('getJudgingPair — entries that arrive after a judge capped the field', () => {
  // Crucible 35: a judge capped every early entry, so the late entries they judged afterwards only
  // ever met each other, and none of the 7 placed.
  it('pairs the late entries against the early ones, not only each other', async () => {
    let entries = Array.from({ length: 12 }, (_, i) => rawEntry(i + 1, 100 + i));
    const judge: Record<number, number> = {};
    const voted = new Set<string>();
    queryRaw.mockImplementation(async () => entries);
    hGetAll.mockImplementation(async (key: string) =>
      key.endsWith(':votes') ? {} : asHash(judge)
    );
    sMembers.mockImplementation(async () => [...voted]);

    // Charges the judge the way submitVote does: an entry already at the cap is the anchor.
    const judgeUntilDone = async () => {
      const served: number[][] = [];
      for (let i = 0; i < 500; i++) {
        const ids = pairIds(await getJudgingPair({ crucibleId: 1, userId: 7 }));
        if (!ids) break;
        voted.add(ids.join(':'));
        for (const id of ids)
          if ((judge[id] ?? 0) < CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY)
            judge[id] = (judge[id] ?? 0) + 1;
        served.push(ids);
      }
      return served;
    };

    await judgeUntilDone();
    expect(
      Object.values(judge).filter((n) => n === CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY),
      'early entries at the cap after the first round'
    ).toHaveLength(12);
    entries = [...entries, ...Array.from({ length: 11 }, (_, i) => rawEntry(13 + i, 200 + i))];
    const late = await judgeUntilDone();

    const isLate = (id: number) => id > 12;
    const lateVsEarly = late.filter(([a, b]) => isLate(a) !== isLate(b)).length;
    expect(late.length, 'the second round ended on its own').toBeLessThan(500);
    expect(new Set(late.map((ids) => ids.join(':'))).size, 'distinct pairs served').toBe(
      late.length
    );
    expect(
      late.every(([a, b]) => isLate(a) || isLate(b)),
      'no early-vs-early pair'
    ).toBe(true);
    expect(lateVsEarly, 'late-vs-early pairs in the second round').toBeGreaterThan(late.length / 4);
  });
});

describe('getJudgingPair — what a judge may see', () => {
  /** Every bound value in a `$queryRaw` call, through any depth of nested `Prisma.sql`. */
  const boundValues = (call: unknown[]): unknown[] =>
    call.slice(1).flatMap(function flatten(value): unknown[] {
      const nested = (value as { values?: unknown[] })?.values;
      return Array.isArray(nested) ? nested.flatMap(flatten) : [value];
    });
  const sqlText = (call: unknown[]): string =>
    [call[0] as string[], ...call.slice(1)]
      .flatMap(function strings(value): string[] {
        if (Array.isArray(value)) return value as string[];
        const sql = value as { strings?: string[]; values?: unknown[] };
        return sql?.strings ? [...sql.strings, ...(sql.values ?? []).flatMap(strings)] : [];
      })
      .join(' ');

  it("samples only entries whose image is scanned and inside both the crucible's and the viewer's levels", async () => {
    findUnique.mockResolvedValue({ ...activeCrucible, nsfwLevel: 7 });
    queryRaw.mockResolvedValue([rawEntry(1, 11), rawEntry(2, 12)]);

    await getJudgingPair({ crucibleId: 1, userId: 7, browsingLevel: 1 });

    const call = queryRaw.mock.calls[0];
    expect(sqlText(call)).toContain('i.ingestion =');
    expect(sqlText(call)).toMatch(/i\."nsfwLevel" & .*i\."nsfwLevel" &/s);
    expect(boundValues(call)).toEqual(expect.arrayContaining([ImageIngestionStatus.Scanned, 7, 1]));
  });

  it('caps the viewer level to SFW on the green site', async () => {
    findUnique.mockResolvedValue({ ...activeCrucible, buzzType: 'green', nsfwLevel: 3 });
    queryRaw.mockResolvedValue([rawEntry(1, 11), rawEntry(2, 12)]);

    await getJudgingPair({ crucibleId: 1, userId: 7, browsingLevel: 31, isGreen: true });

    expect(boundValues(queryRaw.mock.calls[0])).not.toContain(31);
  });

  it('refuses a crucible from the other site, except for a moderator', async () => {
    await expect(getJudgingPair({ crucibleId: 1, userId: 7, isGreen: true })).rejects.toThrow(
      /not found/i
    );

    queryRaw.mockResolvedValue([rawEntry(1, 11), rawEntry(2, 12)]);
    await expect(
      getJudgingPair({ crucibleId: 1, userId: 7, isGreen: true, isModerator: true })
    ).resolves.not.toBeNull();
  });

  it('refuses a crucible still under review', async () => {
    findUnique.mockResolvedValue({ ...activeCrucible, ingestion: CrucibleIngestionStatus.Pending });

    await expect(getJudgingPair({ crucibleId: 1, userId: 7 })).rejects.toThrow(/not found/i);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
