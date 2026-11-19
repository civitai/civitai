import { describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured);
  return { dbRead: db, dbWrite: db };
});
vi.mock('../cache', () => ({ createCache: () => ({ get: vi.fn(), bust: vi.fn() }) }));

const { getNeedsReviewModels, getMinorFlagAppealsForReview } = await import(
  '../minor-hash.service'
);

/** Needs review's file-match half. */
const getMinorHashMatchesForReview = (
  query: Omit<Parameters<typeof getNeedsReviewModels>[0], 'sources'>
) => getNeedsReviewModels({ ...query, sources: { detections: false, matches: true } });

const compile = async (fn: () => Promise<unknown>) => {
  captured.length = 0;
  await fn();
  expect(captured).toHaveLength(1);
  return captured[0];
};

describe('minor queue search', () => {
  it('matches a Pending row against ANY seed sharing its hash, not only the one reported', async () => {
    const statement = await compile(() =>
      getMinorHashMatchesForReview({ limit: 50, search: { modelOrUserId: 900 } })
    );
    expect(statement).toMatch(/EXISTS \(\s*SELECT 1 FROM searched_seeds s3/);
    expect(statement).not.toMatch(/"s"\."minorModelId" = \$/);
  });

  it('filters the seed set by the searched id once, not once per candidate', async () => {
    const statement = await compile(() =>
      getMinorHashMatchesForReview({ limit: 50, search: { modelOrUserId: 900 } })
    );
    // minor_src is an unindexed CTE (~20k rows at real size): an EXISTS over it per candidate cost
    // seconds. Pinned here because pglite results cannot see the plan.
    expect(statement).toMatch(
      /searched_seeds AS MATERIALIZED \([^)]*FROM minor_src\s+WHERE "minorModelId" = \$\d+ OR "userId" = \$\d+/
    );
  });

  it('compares a username case-insensitively', async () => {
    const statement = await compile(() =>
      getMinorHashMatchesForReview({ limit: 50, search: { text: 'Someone' } })
    );
    expect(statement).toContain('lower("u"."username") = lower($');
    expect(statement).toContain(`"c"."modelName" ILIKE $`);
  });

  it('adds nothing but TRUE without a search', async () => {
    const statement = await compile(() => getMinorHashMatchesForReview({ limit: 50 }));
    expect(statement).not.toContain('lower("u"."username")');
  });
});

describe('seed predicate parity with the main app', () => {
  it('excludes both machine sources from the seed set', async () => {
    const statement = await compile(() => getMinorHashMatchesForReview({ limit: 50 }));
    expect(statement).toContain(`->>'source' IS DISTINCT FROM 'auto'`);
    expect(statement).toContain(`->>'source' IS DISTINCT FROM 'text-scan'`);
  });
});

describe('appeals queue', () => {
  it('returns poi and the text-scan verdict', async () => {
    const statement = await compile(() => getMinorFlagAppealsForReview({ limit: 50 }));
    expect(statement).toContain('m.poi');
    expect(statement).toContain(`m.meta->'textScanFlags' AS "textScanFlags"`);
  });
});
