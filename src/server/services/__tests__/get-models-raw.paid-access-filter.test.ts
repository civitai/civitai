import { describe, it, expect, vi } from 'vitest';
// STATIC import, same reasoning as get-models-raw.transient-503.test.ts: model.service
// is a ~4800-line module whose cold transform would otherwise be charged to the first
// test's timeout budget rather than to collection.
import { getModelsRaw, getPermanentPaidAccessModelIds } from '~/server/services/model.service';
import { queryGatedModelIds } from '~/server/services/paid-access.service';
import { paidAccessLiveSql } from '~/server/services/paid-access-sql';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const { capturedQueries } = vi.hoisted(() => ({ capturedQueries: [] as { sql: string }[] }));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (query: { sql: string }) => {
      capturedQueries.push(query);
      return { result: async () => [], cancel: async () => undefined };
    }),
  },
  pgDbWrite: {},
  pgDbReadLong: {},
}));

// Same seams as the transient-503 test: break the event-engine-common import chain and
// no-op the blocked-tag enforcement that runs before the query is built.
vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));

async function sqlFor(input: Record<string, unknown>) {
  capturedQueries.length = 0;
  await getModelsRaw({ input: { browsingLevel: 1, take: 10, ...input } as never });
  expect(capturedQueries).toHaveLength(1);
  return capturedQueries[0].sql;
}

/**
 * The two PaidAccess gate kinds share one table and are told apart by `timeframeDays`,
 * NOT by `endsAt` (a timed gate carries a NULL `endsAt` until publish materializes it).
 * Getting that backwards is silent: the filter still returns rows, just the wrong ones.
 */
describe('getModelsRaw — paidAccess filter', () => {
  it('filters on the permanent-gate discriminator `timeframeDays IS NULL`', async () => {
    const sql = await sqlFor({ paidAccess: true });
    expect(sql).toContain('"timeframeDays" IS NULL');
  });

  // Substring containment cannot see polarity or correlation on its own. Without
  // these three, `NOT EXISTS`, a dropped `pamv."modelId" = m.id` (which makes the
  // subquery uncorrelated, so every model matches as soon as one gate exists
  // anywhere) and a dropped status check all leave the suite green.
  it('emits a correlated, positive EXISTS over published versions only', async () => {
    const sql = await sqlFor({ paidAccess: true });
    // Scoped to THIS subquery on purpose: an unrelated `NOT EXISTS` is emitted for
    // excludedTagIds, and a bare 'NOT EXISTS (' substring check would also match
    // the positive form, since 'EXISTS (' is contained in it.
    expect(sql).not.toMatch(/NOT\s+EXISTS\s*\(\s*SELECT 1 FROM "PaidAccess"/);
    expect(sql).toContain('AND pamv."modelId" = m.id');
    expect(sql).toContain(
      `AND pamv.status = 'Published'::"ModelStatus" AND pa."timeframeDays" IS NULL`
    );
  });

  it('does NOT reuse the early-access `endsAt > NOW()` predicate', async () => {
    const sql = await sqlFor({ paidAccess: true });
    expect(sql).not.toContain('"endsAt" > NOW()');
  });

  it('earlyAccess still filters on the timed-window predicate, not on timeframeDays', async () => {
    const sql = await sqlFor({ earlyAccess: true });
    expect(sql).toContain('"endsAt" > NOW()');
    expect(sql).not.toContain('"timeframeDays" IS NULL');
  });

  it('emits neither predicate when neither flag is set', async () => {
    const sql = await sqlFor({});
    expect(sql).not.toContain('"timeframeDays" IS NULL');
    expect(sql).not.toContain('"endsAt" > NOW()');
  });
});

/**
 * The Prisma path is a SECOND copy of the same discriminator, reached by the
 * moderator `getModelsPagedSimple` surface. Swapping it to `endsAt > NOW()` went
 * unnoticed repo-wide before this test existed.
 */
describe('getPermanentPaidAccessModelIds', () => {
  it('selects permanent gates on `timeframeDays`, never on `endsAt`', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    await getPermanentPaidAccessModelIds();

    // Zero interpolations in that template, so joining the strings IS the statement.
    const sql = (dbMock.dbRead.$queryRaw.mock.calls[0][0] as unknown as string[]).join('');
    expect(sql).toContain('"timeframeDays" IS NULL');
    expect(sql).not.toContain('"endsAt"');
    expect(sql).toContain(`mv.status = 'Published'::"ModelStatus"`);
  });
});

// The `?paidAccess=false` parse assertions that used to live here moved to
// src/server/schema/__tests__/get-all-models.boolean-params.schema.test.ts, which derives
// its field list from the schema instead of naming paidAccess. Same invariant, and it
// also covers the next field someone declares on z.coerce.boolean().

/**
 * `hidePaid` is the only filter here whose polarity is load-bearing: every other clause in this file
 * narrows the result to something, and this one removes. Swap NOT EXISTS for EXISTS and the feed
 * shows ONLY paid models to a user who asked to see none — the exact opposite, with rows still
 * returned and nothing to notice.
 *
 * It also has to use the SAME rule as the badge (`getModelPaidAccessGates`). A hide filter keyed on
 * `timeframeDays` would leave a card reading "Paid" on screen for the 36 published versions whose
 * timed gate was never materialized.
 */
describe('getModelsRaw — hidePaid filter', () => {
  it('EXCLUDES gated models — the clause is negative, correlated, and published-only', async () => {
    const sql = await sqlFor({ hidePaid: true });
    expect(sql).toMatch(/NOT\s+EXISTS\s*\(\s*SELECT 1 FROM "PaidAccess"/);
    // Without the correlation the subquery is uncorrelated: one gate anywhere hides every model.
    expect(sql).toContain('AND mv."modelId" = m.id');
    expect(sql).toContain(`mv.status = 'Published'::"ModelStatus"`);
    expect(sql).toContain(`pa."entityType" = 'ModelVersion'`);
  });

  it('uses the live-gate predicate, not the permanent discriminator', async () => {
    const sql = await sqlFor({ hidePaid: true });
    // Same translation of isPaidAccessActive the badge uses. `timeframeDays IS NULL` here would
    // hide permanent gates only and leave live timed windows visible under a "hide paid" filter.
    expect(sql).toContain('AND (pa."endsAt" IS NULL OR pa."endsAt" > NOW())');
    // The whole column, not the `IS NULL` spelling: `not.toContain('"timeframeDays" IS NULL')` is
    // satisfied by `IS NOT NULL`, and appending that clause silently stops Hide Paid hiding permanent
    // gates while the badge keeps calling them Paid. Measured green across this whole file before the
    // assertion was widened.
    expect(sql).not.toContain('"timeframeDays"');
  });

  it.each([{}, { hidePaid: false }])('emits nothing when the flag is off (%o)', async (input) => {
    const sql = await sqlFor(input);
    expect(sql).not.toMatch(/NOT\s+EXISTS\s*\(\s*SELECT 1 FROM "PaidAccess"/);
  });
});

/**
 * The unbounded half, used by the Prisma `getModels` path. Same rule as the batched badge helper —
 * they are two queries answering one question, so a divergence here is invisible on the feed and
 * visible only as a filter that disagrees with the label.
 */
describe('queryGatedModelIds', () => {
  it('selects every LIVE gate, timed or permanent, on published versions', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValueOnce([]);
    await queryGatedModelIds();

    // `.at(-1)` is load-bearing: there is no global clearMocks, so calls accumulate across the file.
    const call = dbMock.dbRead.$queryRaw.mock.calls.at(-1);
    const strings = (call?.[0] as unknown as string[]).join('');

    // The predicate is INTERPOLATED now, so it lives in the values, not in the template strings —
    // `.join('')` splices straight past it. Assert the surrounding statement here and the identity of
    // what was spliced in; what the fragment SAYS is pinned once, in its own test.
    expect(strings).toContain('SELECT DISTINCT mv."modelId"');
    expect(strings).toContain('JOIN "ModelVersion" mv ON mv.id = pa."entityId"');
    expect(call?.[1]).toBe(paidAccessLiveSql);
  });
});
