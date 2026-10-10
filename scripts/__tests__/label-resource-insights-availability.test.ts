import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Availability } from '~/shared/utils/prisma/enums';

/**
 * Regression guard for the corpus predicate of the labeling pass.
 *
 * THE BUG THIS PINS: the page query used to filter
 * `availability: { not: 'Unsearchable' }` on both the model version and its
 * model. `Unsearchable` means "public, but kept out of search results" — see
 * the enum's own comment in
 * packages/civitai-db-schema/prisma/schema.full.prisma — so that predicate
 * excluded PUBLIC resources while still admitting PRIVATE ones, and the pass
 * sent private creator metadata to a third-party vendor. The serving-side
 * matcher gates on the correct member already
 * (src/server/services/resource-intent-matcher.service.ts filters
 * `ne('availability', Availability.Private)`); this pass had drifted from it.
 *
 * WHY IT ASSERTS THE ISSUED QUERY RATHER THAN A BUILDER. The `where` object is
 * constructed inline in `main()`, so a test over an extracted constant could go
 * green while the call site still passed something else — exactly the failure
 * recorded in the docstring of
 * scripts/__tests__/backfill-reaction-metric-exclusions.test.ts, where moving a
 * choice into a tested function left the call site mutable and every assertion
 * still passed. So this spies on `dbRead.modelVersion.findMany` and reads the
 * argument the run actually issues.
 *
 * WHY BOTH HALVES GET THEIR OWN TEST. The version's availability and its
 * model's are independent columns, and on the live database BOTH mixed
 * combinations occur: public versions under private models, and private
 * versions under public models. A fixture that varies only one side cannot see
 * a bug in the other, so each half is asserted separately and each mutation
 * kills a differently-named test.
 *
 * NO VENDOR CALL AND NO WRITE. `findMany` resolves to `[]`, so `main()` breaks
 * out of its loop on the first page, before `askJev`, before the
 * `resourceInsight` read and before any upsert.
 */

const findMany = vi.fn();
const resourceInsightFindMany = vi.fn();
const upsert = vi.fn();

vi.mock('~/server/db/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dbRead: {
    modelVersion: { findMany: (...args: unknown[]) => findMany(...args) },
    resourceInsight: { findMany: (...args: unknown[]) => resourceInsightFindMany(...args) },
  },
  dbWrite: {
    resourceInsight: { upsert: (...args: unknown[]) => upsert(...args) },
  },
}));

type PageArgs = {
  where: {
    status: string;
    availability: { not: string };
    model: { status: string; availability: { not: string } };
  };
};

/** The `where` the run actually issued for its first page. */
async function issuedPageWhere(): Promise<PageArgs['where']> {
  const { main } = await import('../label-resource-insights');
  await main();
  // Positive control: an assertion over `mock.calls[0]` is meaningless if the
  // query never ran, and a predicate bug would not change the call count.
  expect(findMany).toHaveBeenCalledTimes(1);
  return (findMany.mock.calls[0][0] as PageArgs).where;
}

describe('label-resource-insights corpus predicate', () => {
  let argv: string[];

  beforeEach(() => {
    findMany.mockReset();
    resourceInsightFindMany.mockReset();
    upsert.mockReset();
    // An empty page ends the scan immediately.
    findMany.mockResolvedValue([]);
    // `parseArgs({ strict: true })` reads `process.argv.slice(2)`, which under
    // vitest holds the runner's own flags and would throw on them.
    //
    // 🔴 `argv[1]` must NOT end with `label-resource-insights.ts`. The script's
    // own tail guard self-executes `main()` when it does, so spelling the real
    // script path here runs the pass once at import and again on the explicit
    // call — which the `toHaveBeenCalledTimes(1)` control above catches as a
    // count of 2. Only `slice(2)` is read, so `argv[1]` is free.
    argv = process.argv;
    process.argv = ['node', 'vitest'];
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it("excludes Private on the model VERSION's own availability", async () => {
    const where = await issuedPageWhere();
    expect(where.availability).toEqual({ not: Availability.Private });
  });

  it("excludes Private on the parent MODEL's availability", async () => {
    const where = await issuedPageWhere();
    expect(where.model.availability).toEqual({ not: Availability.Private });
  });

  it('never excludes Unsearchable, which is a public state', async () => {
    const where = await issuedPageWhere();
    // Scans the whole issued predicate, so a reintroduced clause is caught
    // wherever it is added rather than only in the two positions above.
    expect(JSON.stringify(where)).not.toContain('Unsearchable');
  });

  it('still requires both the version and its model to be Published', async () => {
    const where = await issuedPageWhere();
    expect(where.status).toBe('Published');
    expect(where.model.status).toBe('Published');
  });

  it('reads nothing and writes nothing when the first page is empty', async () => {
    await issuedPageWhere();
    expect(resourceInsightFindMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});
