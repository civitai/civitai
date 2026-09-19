import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import type * as EloService from '~/server/services/crucible-elo.service';
import { dbMock, redisMock } from '~/__tests__/mocks';

// `~/server/db/client` and `~/server/redis/client` are registered globally by the setup file
// and reset per test file — see docs/testing/shared-module-mocks.md. Declare behaviour, never
// re-mock the specifier.
const findUnique = dbMock.dbRead.crucible.findUnique;
const queryRaw = dbMock.dbRead.$queryRaw;
const sIsMember = redisMock.sysRedis.sIsMember;
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

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(activeCrucible);
  getAllEntryElos.mockResolvedValue({});
  sIsMember.mockResolvedValue(0);
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
  it('gives up after a bounded number of samples when every pair is already voted', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99), rawEntry(2, 98), rawEntry(3, 97)]);
    sIsMember.mockResolvedValue(1); // every candidate pair has been voted on

    const pair = await getJudgingPair({ crucibleId: 1, userId: 1 });

    expect(pair).toBeNull();
    // The retry loop is capped at MAX_SAMPLE_ATTEMPTS. Asserting the exact count means removing
    // that cap fails here in milliseconds rather than spinning the sampler forever.
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it('returns a pair the judge has not yet seen', async () => {
    queryRaw.mockResolvedValue([rawEntry(1, 99), rawEntry(2, 98)]);
    sIsMember.mockResolvedValue(0);

    const pair = await getJudgingPair({ crucibleId: 1, userId: 1 });

    expect(pair).not.toBeNull();
    expect(sIsMember).toHaveBeenCalled();
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
