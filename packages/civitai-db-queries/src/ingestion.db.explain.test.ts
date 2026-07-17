import { afterAll, describe, expect, it } from 'vitest';
import {
  applyIngestionErrorResolution,
  countImagesPendingIngestion,
  getImagesPendingIngestion,
  getIngestionErrorImages,
  getIngestionResults,
  resolveIngestionError,
} from './ingestion.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema — validates that the
// columns/joins/types resolve against the real database without executing the statement (safe for the writes
// below). Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('ingestion queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getImagesPendingIngestion plans against the real schema', async () => {
    await getImagesPendingIngestion(h.db, { cursor: -1, limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('countImagesPendingIngestion plans against the real schema', async () => {
    await countImagesPendingIngestion(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getIngestionErrorImages plans (raw INTERVAL window + enum cast) against the real schema', async () => {
    await getIngestionErrorImages(h.db, { limit: 20, cursor: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('applyIngestionErrorResolution plans the UPDATE and the post roll-up (writes, not executed)', async () => {
    h.queries.length = 0; // isolate this function's two statements from earlier tests' captures
    await applyIngestionErrorResolution(h.db, {
      id: -1,
      nsfwLevel: 0,
      postId: -1,
      existingMetadata: null,
    });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2); // the UPDATE and the update_post_nsfw_levels(...) call
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('getIngestionResults plans the image, tag, and vote queries against the real schema', async () => {
    h.queries.length = 0;
    await getIngestionResults(h.db, { ids: [-1, -2], userId: -1 });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(3); // images, composite tags, caller votes
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('resolveIngestionError plans its read-guard query against the real schema', async () => {
    // The offline driver backs the query functions, so the read returns no rows and the guard throws; we
    // only get to (and thus EXPLAIN) the read query itself here.
    await expect(resolveIngestionError(h.db, { id: -1, nsfwLevel: 0, userId: -1 })).rejects.toThrow(
      'Image not found'
    );
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
