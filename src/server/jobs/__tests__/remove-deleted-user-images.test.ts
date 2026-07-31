import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  mockDbRead,
  mockDbWrite,
  mockDeleteImages,
  mockLogToAxiom,
  mockSafeError,
  mockSysRedis,
  mockGetJobDate,
} = vi.hoisted(() => ({
  mockDbRead: { $queryRaw: vi.fn() },
  mockDbWrite: { $queryRaw: vi.fn(), $executeRaw: vi.fn() },
  mockDeleteImages: vi.fn(),
  mockLogToAxiom: vi.fn(async () => undefined),
  mockSafeError: vi.fn((e: unknown) => ({
    message: (e as Error).message,
    stack: (e as Error).stack,
  })),
  mockSysRedis: { get: vi.fn() },
  mockGetJobDate: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/image.service', () => ({ deleteImages: mockDeleteImages }));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: mockLogToAxiom,
  safeError: mockSafeError,
}));
vi.mock('~/server/redis/client', () => ({
  sysRedis: mockSysRedis,
  REDIS_SYS_KEYS: { SYSTEM: { DELETED_USER_IMAGE_PURGE_LIMIT: 'k' } },
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: mockGetJobDate,
}));

import {
  removeDeletedUserImages,
  CURSOR_START,
  DEFAULT_IMAGES_PER_RUN,
  FRESH_CURSOR_KEY as FRESH_KEY,
  BACKLOG_CURSOR_KEY as BACKLOG_KEY,
} from '~/server/jobs/remove-deleted-user-images';

/**
 * The suite stands in a tiny in-memory Postgres for the job: `seed()` interprets each SQL
 * statement the job issues against the fixtures, including the `deletedAt` gates and both
 * cursor bounds. A restored user is therefore only protected if the job actually carries the
 * gate — dropping it makes the fixture hand back the rows and the restore tests fail.
 */
type Fixture = {
  deletedAt: Date;
  images: number[];
  posts?: number[];
  /** Still in the (replica-read) worklist, but the primary now says `deletedAt IS NULL`. */
  restored?: boolean;
  /** Restored in the window between the job's drained-check and its post delete. */
  restoredAfterCheck?: boolean;
  /** Restored once this many image batches have cleared the job's in-batch freshness check. */
  restoreAfterBatches?: number;
};

let fixtures: Record<number, Fixture> = {};
let cursorStore: Record<string, Date> = {};
let cursorSets: Record<string, Date[]> = {};
let imageLimits: number[] = [];
let deletedPostIds: number[] = [];
let batchChecks: Record<number, number> = {};

function seed(next: Record<number, Fixture>) {
  fixtures = next;
  const newestFirst = Object.keys(fixtures)
    .map(Number)
    .sort((a, b) => fixtures[b].deletedAt.getTime() - fixtures[a].deletedAt.getTime());

  mockDbRead.$queryRaw.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    const ascending = sql.includes('ORDER BY u."deletedAt" ASC');
    const [bound, mark] = values.filter((v): v is Date => v instanceof Date);
    const limit = values[values.length - 1] as number;
    // The comparison is read out of the SQL, not assumed, so a strict bound in the job shows
    // up here as a skipped timestamp tie instead of being papered over by the fixture.
    const tieSafe = sql.includes(ascending ? 'u."deletedAt" >=' : 'u."deletedAt" <=');
    const inRange = (d: Date) => {
      const withinBound = ascending
        ? tieSafe
          ? d >= bound
          : d > bound
        : tieSafe
        ? d <= bound
        : d < bound;
      // The backlog page carries the high-water mark as a second, always-strict bound.
      return withinBound && (mark === undefined || d < mark);
    };
    const selectsImageOwners = sql.includes('FROM "Image" i WHERE i."userId" = u.id');
    const selectsPostOwners = sql.includes('FROM "Post" p WHERE p."userId" = u.id');
    const order = ascending ? [...newestFirst].reverse() : newestFirst;

    return Promise.resolve(
      order
        .filter((id) => bound === undefined || inRange(fixtures[id].deletedAt))
        .filter(
          (id) =>
            (selectsImageOwners && fixtures[id].images.length > 0) ||
            (selectsPostOwners && (fixtures[id].posts ?? []).length > 0)
        )
        .slice(0, limit)
        .map((id) => ({ id, deletedAt: fixtures[id].deletedAt }))
    );
  });

  mockDbWrite.$queryRaw.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const userId = values[0] as number;
      const fixture = fixtures[userId];
      const gated = sql.includes('u."deletedAt" IS NOT NULL');

      if (sql.includes('"hasImages"')) {
        const state = { stillDeleted: !fixture.restored, hasImages: fixture.images.length > 0 };
        if (fixture.restoredAfterCheck) fixture.restored = true;
        return Promise.resolve([state]);
      }
      if (sql.includes('"stillDeleted"')) {
        const checks = (batchChecks[userId] = (batchChecks[userId] ?? 0) + 1);
        if (fixture.restoreAfterBatches != null && checks > fixture.restoreAfterBatches)
          fixture.restored = true;
        return Promise.resolve([{ stillDeleted: !fixture.restored }]);
      }
      if (sql.includes('FROM "Image" i')) {
        const limit = values[1] as number;
        imageLimits.push(limit);
        if (gated && fixture.restored) return Promise.resolve([]);
        return Promise.resolve(fixture.images.slice(0, limit).map((id) => ({ id })));
      }
      if (sql.includes('FROM "Post"'))
        return Promise.resolve((fixture.posts ?? []).map((id) => ({ id })));

      throw new Error(`unexpected dbWrite read: ${sql}`);
    }
  );

  mockDbWrite.$executeRaw.mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      const ids = ((values[0] as { values?: number[] })?.values ?? []) as number[];
      const userId = values[1] as number;
      const fixture = fixtures[userId];
      if (sql.includes('u."deletedAt" IS NOT NULL') && fixture.restored) return Promise.resolve(0);

      deletedPostIds.push(...ids);
      fixture.posts = (fixture.posts ?? []).filter((id) => !ids.includes(id));
      return Promise.resolve(ids.length);
    }
  );

  mockDeleteImages.mockImplementation(async (ids: number[]) => {
    for (const fixture of Object.values(fixtures))
      fixture.images = fixture.images.filter((id) => !ids.includes(id));
    return ids.map((id) => ({ id }));
  });
}

const ids = (count: number, offset = 0) => Array.from({ length: count }, (_, i) => offset + i + 1);

const run = (checkIfCanceled: () => void = () => undefined) =>
  (removeDeletedUserImages as unknown as (ctx: { checkIfCanceled: () => void }) => Promise<any>)({
    checkIfCanceled,
  });

const NOW = new Date('2026-07-31T00:00:00Z');
const RECENT = new Date('2026-07-30T23:00:00Z');
const NEWER = new Date('2026-07-30T10:00:00Z');
const OLDER = new Date('2026-07-29T10:00:00Z');
const ANCIENT = new Date('2024-01-01T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  // The high-water mark seeds itself off the wall clock, so the fixtures' `deletedAt` values
  // only mean "backlog" or "fresh" relative to a pinned now.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fixtures = {};
  cursorStore = {};
  cursorSets = {};
  imageLimits = [];
  deletedPostIds = [];
  batchChecks = {};
  mockSysRedis.get.mockResolvedValue(null);
  mockGetJobDate.mockImplementation(async (key: string, defaultValue: Date) => [
    cursorStore[key] ?? defaultValue,
    async (date?: Date) => {
      cursorStore[key] = date ?? new Date();
      (cursorSets[key] ??= []).push(cursorStore[key]);
    },
  ]);
  seed({});
});

afterEach(() => {
  vi.useRealTimers();
});

describe('removeDeletedUserImages', () => {
  it('deletes a deleted user images in batches of 100 and then removes their posts', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seed({ 7: { deletedAt: NEWER, images: ids(150), posts: [900] } });

    const result = await run();

    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(mockDeleteImages.mock.calls[0][0]).toHaveLength(100);
    expect(mockDeleteImages.mock.calls[1][0]).toHaveLength(50);
    expect(deletedPostIds).toEqual([900]);
    expect(result.deletedImages).toBe(150);
    expect(result.deletedUsers).toBe(1);
  });

  it('leaves posts alone while the user still has images left', async () => {
    mockSysRedis.get.mockResolvedValue('100');
    seed({ 7: { deletedAt: NEWER, images: ids(150), posts: [900] } });

    const result = await run();

    expect(result.deletedImages).toBe(100);
    expect(deletedPostIds).toEqual([]);
  });

  it('deletes posts when the drain lands exactly on the budget', async () => {
    mockSysRedis.get.mockResolvedValue('150');
    seed({ 7: { deletedAt: NEWER, images: ids(150), posts: [900] } });

    // The old count-vs-budget heuristic read "returned exactly the budget" as "more may
    // remain" and stranded these posts forever; the post-drain re-check settles it.
    const result = await run();

    expect(result.deletedImages).toBe(150);
    expect(deletedPostIds).toEqual([900]);
    expect(result.deletedUsers).toBe(1);
  });

  it('deletes posts for a user who owns posts but no images', async () => {
    seed({ 7: { deletedAt: NEWER, images: [], posts: [900, 901] } });

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(deletedPostIds).toEqual([900, 901]);
    expect(result.deletedUsers).toBe(1);
  });

  it('chunks the post delete', async () => {
    seed({ 7: { deletedAt: NEWER, images: [], posts: ids(250, 1000) } });

    await run();

    expect(mockDbWrite.$executeRaw).toHaveBeenCalledTimes(3);
    expect(deletedPostIds).toHaveLength(250);
  });

  it('does nothing when no deleted user owns images or posts', async () => {
    seed({});

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(mockDbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(result.deletedImages).toBe(0);
  });

  it('skips a user restored between the worklist read and the drain', async () => {
    seed({ 7: { deletedAt: NEWER, images: ids(150), posts: [900], restored: true } });

    const result = await run();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(deletedPostIds).toEqual([]);
    expect(result.deletedImages).toBe(0);
    expect(result.deletedUsers).toBe(0);
  });

  it('leaves the posts of a restored user alone', async () => {
    seed({ 7: { deletedAt: NEWER, images: [], posts: [900], restored: true } });

    const result = await run();

    expect(deletedPostIds).toEqual([]);
    expect(result.deletedUsers).toBe(0);
  });

  it('stops draining a user restored between image batches', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seed({ 7: { deletedAt: NEWER, images: ids(300), posts: [900], restoreAfterBatches: 1 } });

    const result = await run();

    // Without a per-batch re-read the restore only costs the ids already fetched — which is
    // every image the budget would have paid for.
    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(result.deletedImages).toBe(100);
    expect(deletedPostIds).toEqual([]);
    expect(result.deletedUsers).toBe(0);
  });

  it('gates the post delete itself, not just the decision to run it', async () => {
    seed({ 7: { deletedAt: NEWER, images: [], posts: [900], restoredAfterCheck: true } });

    const result = await run();

    expect(deletedPostIds).toEqual([]);
    // The gated DELETE affects nothing, so the run neither counts the user nor moves past them.
    expect(result.deletedUsers).toBe(0);
    expect(cursorSets[BACKLOG_KEY]).toBeUndefined();
  });

  it('keeps going when one user fails, and logs the failure with a stack', async () => {
    seed({
      7: { deletedAt: NEWER, images: [1] },
      8: { deletedAt: OLDER, images: [2] },
    });
    const boom = new Error('s3 exploded');
    mockDeleteImages.mockRejectedValueOnce(boom).mockImplementationOnce(async (batch: number[]) => {
      fixtures[8].images = [];
      return batch.map((id) => ({ id }));
    });

    const result = await run();

    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(result.deletedImages).toBe(1);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        name: 'remove-deleted-user-images',
        userId: 7,
        error: expect.objectContaining({ stack: boom.stack }),
      })
    );
    // User 7 may be half-drained, so the cursor must not step over them to reach user 8.
    expect(cursorSets[BACKLOG_KEY]).toBeUndefined();
  });

  it('logs a success line with the run counts', async () => {
    seed({ 7: { deletedAt: NEWER, images: ids(10), posts: [900] } });

    await run();

    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'info',
        name: 'remove-deleted-user-images',
        deletedImages: 10,
        deletedUsers: 1,
      })
    );
  });

  it('checks for cancellation between image batches without logging it as a failure', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seed({ 7: { deletedAt: NEWER, images: ids(300) } });
    let checks = 0;
    const checkIfCanceled = () => {
      // 1 = the per-user check, 2 = the first in-batch check. Without an in-batch check the
      // job never reaches a third call for a single user and all three batches run.
      if (++checks === 3) throw new Error('Job has ended');
    };

    await run(checkIfCanceled);

    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(mockLogToAxiom).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

describe('removeDeletedUserImages cursors', () => {
  it('advances the backlog cursor to the last user it fully drained', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    seed({
      7: { deletedAt: NEWER, images: ids(10), posts: [900] },
      8: { deletedAt: OLDER, images: ids(10, 100), posts: [901] },
    });

    await run();

    expect(cursorSets[BACKLOG_KEY]).toEqual([OLDER]);
  });

  it('does not advance past a user the budget left half-drained', async () => {
    mockSysRedis.get.mockResolvedValue('100');
    seed({
      7: { deletedAt: NEWER, images: ids(150) },
      8: { deletedAt: OLDER, images: ids(10, 200) },
    });

    const first = await run();

    expect(first.deletedImages).toBe(100);
    expect(cursorSets[BACKLOG_KEY]).toBeUndefined();

    // User 7 is still the newest candidate, so the next run resumes on their remainder.
    const second = await run();

    expect(second.deletedImages).toBe(50 + 10);
    expect(fixtures[7].images).toEqual([]);
  });

  it('resets the backlog cursor when its page comes back empty', async () => {
    cursorStore[BACKLOG_KEY] = OLDER;
    seed({ 7: { deletedAt: NEWER, images: ids(10) } });

    const result = await run();

    expect(result.deletedImages).toBe(0);
    expect(cursorSets[BACKLOG_KEY]).toEqual([CURSOR_START]);
  });

  it('picks up a user the backlog cursor had passed once the reset wraps', async () => {
    cursorStore[BACKLOG_KEY] = OLDER;
    seed({ 7: { deletedAt: NEWER, images: ids(10) } });

    await run();
    const second = await run();

    expect(second.deletedImages).toBe(10);
  });

  it('drains a fresh self-deletion on the next run with an undrained backlog below the cursor', async () => {
    mockSysRedis.get.mockResolvedValue('1000');
    cursorStore[FRESH_KEY] = NEWER;
    cursorStore[BACKLOG_KEY] = OLDER;
    seed({
      1: { deletedAt: ANCIENT, images: ids(10), posts: [900] },
      9: { deletedAt: RECENT, images: ids(10, 100), posts: [901] },
    });

    await run();

    // A single descending cursor sorts every deletion newer than itself out of range, so the
    // fresh account waits for the whole backlog below the cursor to drain first.
    expect(fixtures[9].images).toEqual([]);
    expect(deletedPostIds).toContain(901);
  });

  it('spends a scarce budget on the fresh deletion before the backlog', async () => {
    mockSysRedis.get.mockResolvedValue('10');
    cursorStore[FRESH_KEY] = NEWER;
    cursorStore[BACKLOG_KEY] = OLDER;
    seed({
      1: { deletedAt: ANCIENT, images: ids(10) },
      9: { deletedAt: RECENT, images: ids(10, 100) },
    });

    const result = await run();

    expect(result.deletedImages).toBe(10);
    expect(fixtures[9].images).toEqual([]);
    expect(fixtures[1].images).toHaveLength(10);
  });

  it('persists the seeded high-water mark on the first run', async () => {
    seed({ 7: { deletedAt: NEWER, images: ids(10) } });

    await run();

    // Re-seeding the mark to a later `now` every run would leave anything deleted in between
    // above the mark and below the backlog cursor — visible to neither pass.
    const selfDeleted = new Date(NOW.getTime() + 30 * 60 * 1000);
    vi.setSystemTime(new Date(NOW.getTime() + 60 * 60 * 1000));
    seed({
      7: { deletedAt: NEWER, images: [] },
      9: { deletedAt: selfDeleted, images: ids(5, 500) },
    });

    const second = await run();

    expect(second.deletedImages).toBe(5);
  });

  it('does not skip accounts that share the cursor timestamp', async () => {
    mockSysRedis.get.mockResolvedValue('10');
    seed({
      7: { deletedAt: NEWER, images: ids(10) },
      8: { deletedAt: NEWER, images: ids(10, 100) },
    });

    const first = await run();

    expect(first.deletedImages).toBe(10);
    expect(cursorSets[BACKLOG_KEY]).toEqual([NEWER]);

    // A bulk delete stamps one `now()` across many accounts; a strict comparison drops the
    // rest of the tie the moment the cursor lands on it.
    const second = await run();

    expect(second.deletedImages).toBe(10);
    expect(fixtures[8].images).toEqual([]);
  });
});

describe('removeDeletedUserImages budget', () => {
  it('does nothing when the Redis limit is 0', async () => {
    mockSysRedis.get.mockResolvedValue('0');

    const result = await run();

    expect(mockDbRead.$queryRaw).not.toHaveBeenCalled();
    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(result.paused).toBe(true);
  });

  it('coerces a Buffer reply from the HA sysRedis', async () => {
    mockSysRedis.get.mockResolvedValue(Buffer.from('150'));
    seed({ 7: { deletedAt: NEWER, images: ids(200) } });

    const result = await run();

    // Budget of 150 (not the 200 available, not the compiled default) honoured:
    // a full batch of 100, then a truncated batch of 50.
    expect(mockDeleteImages).toHaveBeenCalledTimes(2);
    expect(mockDeleteImages.mock.calls[1][0]).toHaveLength(50);
    expect(result.deletedImages).toBe(150);
  });

  it('floors a fractional Redis value so the LIMIT stays an integer', async () => {
    mockSysRedis.get.mockResolvedValue('1.5');
    seed({ 7: { deletedAt: NEWER, images: ids(10) } });

    const result = await run();

    // `LIMIT 1.5` is a Postgres type error that takes down every user in the run.
    expect(imageLimits).toEqual([1]);
    expect(result.deletedImages).toBe(1);
  });

  it('stops at the budget and leaves later users for the next run', async () => {
    mockSysRedis.get.mockResolvedValue('100');
    seed({
      7: { deletedAt: NEWER, images: ids(100) },
      8: { deletedAt: OLDER, images: ids(10, 200) },
    });

    const result = await run();

    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(result.deletedImages).toBe(100);
    expect(fixtures[8].images).toHaveLength(10);
  });

  it('falls back to a conservative default when the key is unset', async () => {
    mockSysRedis.get.mockResolvedValue(null);
    seed({ 7: { deletedAt: NEWER, images: ids(600), posts: [900] } });

    const result = await run();

    expect(DEFAULT_IMAGES_PER_RUN).toBe(500);
    expect(result.deletedImages).toBe(500);
    expect(deletedPostIds).toEqual([]);
  });

  it('falls back to the default when the Redis value is not a number', async () => {
    mockSysRedis.get.mockResolvedValue('not-a-number');
    seed({ 7: { deletedAt: NEWER, images: ids(150) } });

    const result = await run();

    // A broken fallback that lets a non-finite budget through would cap `remaining`
    // at NaN and process nothing.
    expect(result.deletedImages).toBe(150);
    expect(result.paused).toBeUndefined();
  });

  it('falls back to the default when the Redis value is negative', async () => {
    mockSysRedis.get.mockResolvedValue('-5');
    seed({ 7: { deletedAt: NEWER, images: ids(150) } });

    const result = await run();

    // A broken fallback that lets -5 through would make the job's own `budget <= 0`
    // gate pause it instead of running with the default.
    expect(result.deletedImages).toBe(150);
    expect(result.paused).toBeUndefined();
  });
});
