import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { explainHarness } from '../../../test/explain-harness';

/**
 * The per-version image count is a RAW `sql` fragment — a UNION of the showcase posts and the resource
 * uses, correlated on `mv."id"` — because it has to resolve the same set Bulk Image Manager does and
 * Kysely cannot express that. Raw SQL is invisible to TypeScript: a wrong column, a lost alias or an
 * unparenthesised subquery compiles, lints and typechecks, and fails only when the page is opened.
 *
 * So these PLAN the real statements against the live schema. Nothing is executed.
 */

const h = explainHarness();

vi.mock('../db', () => ({ dbRead: h.db, dbWrite: h.db }));
vi.mock('../mod-activity', () => ({
  getModActivityFor: async () => ({ rows: [], truncated: false }),
}));
vi.mock('../users.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../users.service')>()),
  usersByIds: async () => new Map(),
}));

const { getModelLookup, getVersions } = await import('../model-lookup.service');

beforeEach(() => h.reset());
afterAll(() => h.destroy());

describe.skipIf(!h.hasDb)('the model lookup reads plan against the real schema', () => {
  it('plans every statement the page issues', async () => {
    // The DummyDriver answers no rows, so the model read misses and the rest never run — each query
    // is compiled on the way past regardless, which is what the harness collects.
    await getModelLookup(1234);
    expect(h.queries.length).toBeGreaterThan(0);
    for (const plan of await h.explainAll()) expect(plan).toBeTruthy();
  });

  // Called directly: `getModelLookup` stops at the model read, which the DummyDriver answers with no
  // rows, so the versions statement is never reached through it.
  it('counts a version’s images over BOTH sources, not just the showcase posts', async () => {
    await getVersions(1234);

    expect(h.queries.length).toBe(1);
    const [versionQuery] = h.queries;
    expect(versionQuery.sql).toContain('"ImageResourceNew"');
    expect(versionQuery.sql).toContain('"Post"');
    expect(versionQuery.sql).toMatch(/UNION/i);

    const plan = await h.explain(versionQuery);
    expect(plan).toBeTruthy();
    // The cap is what makes the union affordable per version; without it the widest models take
    // seconds each. A plan with no Limit means the cap was dropped.
    expect(plan).toMatch(/Limit/i);
  });
});
