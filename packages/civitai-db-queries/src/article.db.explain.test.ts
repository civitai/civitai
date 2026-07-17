import { afterAll, describe, expect, it } from 'vitest';
import {
  countArticlesForModeration,
  deleteArticleFiles,
  deleteArticleForUser,
  deleteArticleImageConnections,
  deleteArticleReactionForUser,
  deleteArticleRecord,
  getArticleContentImageIngestion,
  getArticleContentImages,
  getArticleCoverIngestion,
  getArticleForRescan,
  getArticleForRestore,
  getArticleForUnpublish,
  getArticleTextModeration,
  getArticlesForModeration,
  lockArticleForIngestion,
  refreshArticleNsfwLevel,
  refreshArticleNsfwLevelMany,
  setArticleIngestion,
  setArticleIngestionState,
  setArticleRescanRequested,
  setArticleRestored,
  setArticleUnpublished,
  updateArticle,
} from './article.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported statement against the live schema. This never executes the
// statement — safe for the writes below — but it parses + plans it, so a query whose columns, joins, or enum
// casts don't resolve against the real database fails here even though the compile-only test passed. Skips
// when no DB URL is available (see the harness). Each restore/delete DB statement is ported separately so it
// plans on its own (the offline DummyDriver returns no rows, so a read-then-guard fn would throw first).
const h = explainHarness();

describe.skipIf(!h.hasDb)('articles queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getArticlesForModeration (count + items) plans', async () => {
    await getArticlesForModeration(h.db, { status: 'Unpublished', username: 'a', limit: 20 });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('countArticlesForModeration plans', async () => {
    await countArticlesForModeration(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateArticle plans (write, not executed)', async () => {
    await updateArticle(h.db, { id: -1, status: 'Published' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleForRestore plans', async () => {
    await getArticleForRestore(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleForUnpublish plans', async () => {
    await getArticleForUnpublish(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleForRescan plans', async () => {
    await getArticleForRescan(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setArticleRestored plans (write, not executed)', async () => {
    await setArticleRestored(h.db, { id: -1, publishedAt: new Date(), metadata: {} });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('refreshArticleNsfwLevel plans (write, not executed) — validates the nsfwLevel re-derive CTE', async () => {
    await refreshArticleNsfwLevel(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleContentImageIngestion plans', async () => {
    await getArticleContentImageIngestion(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleCoverIngestion plans', async () => {
    await getArticleCoverIngestion(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleTextModeration plans', async () => {
    await getArticleTextModeration(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setArticleIngestion plans (write, not executed)', async () => {
    await setArticleIngestion(h.db, { id: -1, ingestion: 'Scanned', contentScannedAt: new Date() });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteArticleFiles plans (write, not executed)', async () => {
    await deleteArticleFiles(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteArticleImageConnections plans (write, not executed)', async () => {
    await deleteArticleImageConnections(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteArticleRecord plans (write, not executed)', async () => {
    await deleteArticleRecord(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setArticleUnpublished plans (write, not executed)', async () => {
    await setArticleUnpublished(h.db, { id: -1, status: 'Unpublished', metadata: {} });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setArticleRescanRequested plans (write, not executed)', async () => {
    await setArticleRescanRequested(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getArticleContentImages plans', async () => {
    await getArticleContentImages(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('lockArticleForIngestion plans', async () => {
    await lockArticleForIngestion(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setArticleIngestionState plans (write, not executed) — with the publish flip', async () => {
    await setArticleIngestionState(h.db, {
      id: -1,
      ingestion: 'Scanned',
      contentScannedAt: new Date(),
      publishedAt: new Date(),
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('refreshArticleNsfwLevelMany plans (write, not executed) — validates the bulk re-derive CTE', async () => {
    await refreshArticleNsfwLevelMany(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteArticleForUser plans (write, not executed)', async () => {
    await deleteArticleForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteArticleReactionForUser plans (write, not executed)', async () => {
    await deleteArticleReactionForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
