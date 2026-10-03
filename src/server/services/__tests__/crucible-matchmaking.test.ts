import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';
import type * as EloService from '~/server/services/crucible-elo.service';
import { dbMock, redisMock } from '~/__tests__/mocks';

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

/** Each entry's vote count across all judges, where `crucibleEloRedis.getAllVoteCounts` reads it. */
const withVoteCounts = (counts: Record<number, number>) =>
  hGetAll.mockImplementation(async (key: string) =>
    key.endsWith(':votes')
      ? Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, String(n)]))
      : {}
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
    queryRaw.mockResolvedValue(ids.map((id) => rawEntry(id, 1000 + id)));
    withVotedPairs(
      ...ids.flatMap((a) => ids.filter((b) => b > a).map((b) => [a, b] as [number, number]))
    );

    expect(await getJudgingPair({ crucibleId: 1, userId: 1 })).toBeNull();
    // The retry loop is capped at MAX_SAMPLE_ATTEMPTS. Asserting the exact count means removing
    // that cap fails here in milliseconds rather than spinning the sampler forever.
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

    const pair = await getJudgingPair({ crucibleId: 1, userId: 7, excludeEntryIds: [1, 2] });

    expect(pair, 'three unjudged pairs were left, only behind the skip list').not.toBeNull();
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
    queryRaw.mockResolvedValueOnce(oneAuthor).mockResolvedValueOnce(mixed);

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

  it('brings a skipped entry back for a cross-author pair rather than serve a same-author one', async () => {
    const all = [rawEntry(1, 50), rawEntry(2, 50), rawEntry(3, 60)];
    queryRaw.mockImplementation(async (strings: TemplateStringsArray) =>
      strings.join('').includes('NOT IN') ? all.filter((e) => e.id !== 3) : all
    );

    const pair = await getJudgingPair({ crucibleId: 1, userId: 7, excludeEntryIds: [3] });

    expect(pairIds(pair)).toContain(3);
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
    expect(redisMock.sysRedis.sAdd).toHaveBeenCalledWith(
      expect.stringMatching(/served:1:7$/),
      '1:2'
    );
  });

  it('never serves an entry the judge has already voted on as often as allowed', async () => {
    const { CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY } = await import(
      '~/server/services/crucible.service'
    );
    queryRaw.mockResolvedValue([rawEntry(1, 11), rawEntry(2, 12), rawEntry(3, 13)]);
    redisMock.sysRedis.hGetAll.mockResolvedValue({
      '1': String(CRUCIBLE_MAX_VOTES_PER_JUDGE_PER_ENTRY),
    });

    for (let i = 0; i < 20; i++) {
      const pair = await getJudgingPair({ crucibleId: 1, userId: 7 });
      expect([pair?.left.id, pair?.right.id].sort()).toEqual([2, 3]);
    }
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
