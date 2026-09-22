import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The only test that reads the SQL the post reaction job actually sends.
 *
 * Everything else protecting this change is a source guard, and a source guard checks
 * that a token appears in a file — not what the composed statement does. Four separate
 * mutations were demonstrated to pass a token check while leaving the defect in place:
 * swapping the table aliases so `r."userId"` names the image owner instead of the
 * reactor, swallowing the strict read in a try/catch, commenting the splice out, and
 * counting the same table a second time in the same template literal. All four change
 * the emitted SQL, which is why this asserts on that.
 */

const h = vi.hoisted(() => ({
  excludedIds: vi.fn(),
}));

vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIdsOrThrow: h.excludedIds,
}));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: vi.fn().mockResolvedValue(true),
  FLIPT_FEATURE_FLAGS: {},
  buildEntityMetricPerDaySource: (where: string) => `entityMetricEvents_day ${where}`,
}));

const { getReactionTasks } = await import('~/server/metrics/post.metrics');

type Captured = { sql: string; params?: unknown[] };

/**
 * Two image chunks, because one cannot expose the ordering hazard.
 *
 * `getAffected` sorts its own return, so a single chunk always lands in `affected`
 * ascending. In production the image ids are chunked at 30,000 and the chunks run
 * CONCURRENTLY, so `affected` ends up as several sorted runs concatenated — globally
 * unsorted. The job then bounds each post chunk with `BETWEEN ids[0] AND ids[last]`, and
 * an inverted range matches nothing; with zeros seeded, a chunk that matches nothing
 * writes zeros over real counts. So the fixture crosses the chunk boundary and returns a
 * LOWER run second, which is the shape that actually breaks.
 */
const IMAGE_CHUNK = 30_000;
const IMAGE_IDS = Array.from({ length: IMAGE_CHUNK + 1 }, (_, i) => i + 1);
const POST_RUNS = [
  [500, 600],
  [100, 200],
];
const POST_IDS = POST_RUNS.flat();

function makeCtx(reactionRows: Record<string, unknown>[]) {
  const captured: Captured[] = [];
  let imageChunkCalls = 0;
  const updates: Record<number, Record<string, number>> = {};
  const ctx = {
    ch: { $query: vi.fn().mockResolvedValue(IMAGE_IDS.map((imageId) => ({ imageId }))) },
    pg: {
      cancellableQuery: vi.fn(async (sql: string, params?: unknown[]) => {
        captured.push({ sql, params });
        // The affected-post lookup selects `id`; the reaction aggregate selects counts.
        // Each image chunk returns its own run of post ids, second run lower than first.
        if (/FROM "Image" i/.test(sql)) {
          const run = POST_RUNS[imageChunkCalls++] ?? [];
          return { result: async () => run.map((id) => ({ id })), cancel: async () => undefined };
        }
        return { result: async () => reactionRows, cancel: async () => undefined };
      }),
    },
    jobContext: { checkIfCanceled: () => undefined, on: () => undefined },
    queue: [] as number[],
    affected: new Set<number>(),
    addAffected: (id: number | number[]) => {
      if (Array.isArray(id)) id.forEach((x) => ctx.affected.add(x));
      else ctx.affected.add(id);
    },
    updates,
    idKey: 'postId',
    lastUpdate: new Date('2026-09-01T00:00:00Z'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { ctx, captured, updates };
}

const aggregateSql = (captured: Captured[]) =>
  captured.map((c) => c.sql).find((sql) => /FROM "ImageReaction"/.test(sql));

beforeEach(() => {
  vi.clearAllMocks();
  h.excludedIds.mockResolvedValue([11, 22]);
});

describe('post reaction metrics SQL', () => {
  it('filters the REACTOR, by the alias the reaction table is bound to', async () => {
    const { ctx, captured } = makeCtx([]);
    const tasks = await getReactionTasks(ctx);
    await Promise.all(tasks.map((t) => t()));

    const sql = aggregateSql(captured);
    expect(sql, 'the reaction aggregate was never issued').toBeDefined();

    // The alias the filter names must be the alias bound to the reaction table, not to
    // `Image` — `Image."userId"` exists, so the wrong alias is valid SQL that filters by
    // the post's owner and is invisible to any check that only looks for the predicate.
    const alias = /FROM "ImageReaction"\s+(\w+)/.exec(sql!)?.[1];
    expect(alias).toBeDefined();
    expect(sql).toContain(`AND ${alias}."userId" NOT IN (11,22)`);
  });

  it('puts the filter in the executed statement, not in a comment', async () => {
    const { ctx, captured } = makeCtx([]);
    const tasks = await getReactionTasks(ctx);
    await Promise.all(tasks.map((t) => t()));

    const sql = aggregateSql(captured)!;
    const filterLine = sql.split('\n').find((l) => l.includes('NOT IN (11,22)'))!;
    expect(filterLine, 'the filter is inside an SQL line comment').not.toMatch(/--/);
    expect(sql, 'the filter is inside a block comment').not.toMatch(
      /\/\*[\s\S]*NOT IN \(11,22\)[\s\S]*\*\//
    );
  });

  it('counts the reaction table exactly once, all of it filtered', async () => {
    // A second, unfiltered count of the same table added to the same statement is the
    // realistic next defect — "also show the raw total" lands inside the existing query.
    const { ctx, captured } = makeCtx([]);
    const tasks = await getReactionTasks(ctx);
    await Promise.all(tasks.map((t) => t()));

    const sql = aggregateSql(captured)!;
    const references = sql.match(/"ImageReaction"/g) ?? [];
    const filters = sql.match(/NOT IN \(11,22\)/g) ?? [];
    expect(filters.length).toBe(references.length);
  });

  it('seeds zero for a post the aggregate returns no row for', async () => {
    // The all-excluded case: a GROUP BY returns no row, and a missing row means
    // "no change" to every writer downstream, so the pre-exclusion total would survive.
    const { ctx, updates } = makeCtx([]);
    const tasks = await getReactionTasks(ctx);
    await Promise.all(tasks.map((t) => t()));

    for (const postId of POST_IDS) {
      expect(updates[postId], `post ${postId} missing from updates`).toBeDefined();
      expect(updates[postId].heartCount).toBe(0);
      expect(updates[postId].likeCount).toBe(0);
    }
  });

  it('lets the aggregate overwrite the seeded zero', async () => {
    // Negative control for the test above: the zeros must be a floor, not a ceiling.
    const { ctx, updates } = makeCtx([
      { postId: 500, timeframe: 'AllTime', heartCount: 7, likeCount: 3 },
    ]);
    const tasks = await getReactionTasks(ctx);
    await Promise.all(tasks.map((t) => t()));

    expect(updates[500].heartCount).toBe(7);
    expect(updates[500].likeCount).toBe(3);
    expect(updates[100].heartCount).toBe(0);
  });

  it('bounds each chunk with an ascending range', async () => {
    // `BETWEEN ids[0] AND ids[last]` over an unsorted chunk matches nothing, and with the
    // seeding above that writes zeros over real counts. The fixture ids are unsorted.
    const { ctx, captured } = makeCtx([]);
    const tasks = await getReactionTasks(ctx);
    await Promise.all(tasks.map((t) => t()));

    const ranges = captured
      .map((c) => /BETWEEN (\d+) AND (\d+)/.exec(c.sql))
      .filter((m): m is RegExpExecArray => !!m);

    expect(ranges.length, 'no BETWEEN-bounded query was issued').toBeGreaterThan(0);
    for (const [, lo, hi] of ranges) {
      expect(Number(lo), `range ${lo}..${hi} is inverted and matches nothing`).toBeLessThanOrEqual(
        Number(hi)
      );
    }
  });

  it('issues no query at all when the exclusion list cannot be read', async () => {
    // The strict reader must reject before any task is built, so the run fails before the
    // cursor advances rather than writing an unfiltered total.
    h.excludedIds.mockRejectedValue(new Error('clickhouse unreachable'));
    const { ctx, captured } = makeCtx([]);

    await expect(getReactionTasks(ctx)).rejects.toThrow('clickhouse unreachable');
    expect(captured).toEqual([]);
    expect(ctx.ch.$query).not.toHaveBeenCalled();
  });
});
