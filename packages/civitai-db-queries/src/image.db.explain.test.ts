import { afterAll, describe, expect, it } from 'vitest';
import { explainHarness } from './test/harness';
import { getImageGenerationFields, listImageReactionsMany } from './image.db';

const h = explainHarness();

afterAll(() => h.destroy());

// DB-backed tier: EXPLAIN (no ANALYZE) parses + plans against the live schema without executing, so a
// column, type or join that doesn't resolve fails here even though the compile test passed. Skips when
// no DB is reachable.
describe.skipIf(!h.hasDb)('image.db queries EXPLAIN against the real schema', () => {
  it('getImageGenerationFields plans, reading Image by its primary key', async () => {
    // 42, not 1: the plan shows the bound value, and 42 appears nowhere else in it.
    await getImageGenerationFields(h.db, 42);
    // Which plan Postgres picks depends on table statistics (a small analysed Image table is rightly
    // seq-scanned), so this pins whether the id lookup CAN use the primary key, with seq scans
    // disabled. The Index Cond is part of the assertion: with seq scans off, a query that lost its
    // id predicate gets a full index scan of Image_pkey instead, which the scan type alone would pass.
    const plan = await h.explainLast({ disableSeqScan: true });
    expect(plan).toMatch(
      /Index (Only )?Scan using "Image_pkey" on "Image"[^\n]*\n\s*Index Cond: \(id = 42\)/
    );
  });

  it('listImageReactionsMany plans, reading ImageReaction through its (imageId, userId, reaction) key', async () => {
    // Distinct values: 7 is the user, never an image id, so the Index Cond shows which is which.
    await listImageReactionsMany(h.db, { imageIds: [11, 22, 33], userId: 7 });
    // Seq scans disabled for the same reason as above. Plain or bitmap index scan are both fine;
    // what is pinned is that BOTH predicates reach the unique index's condition, so a lost
    // `userId` filter (every viewer's reactions) cannot pass as a narrower scan.
    const plan = await h.explainLast({ disableSeqScan: true });
    expect(plan).toMatch(
      /(Index (Only )?Scan using|Bitmap Index Scan on) "ImageReaction_imageId_userId_reaction_key"[^\n]*\n\s*Index Cond: [^\n]*"imageId"[^\n]*"userId" = 7/
    );
  });
});
