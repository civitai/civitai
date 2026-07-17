import { afterAll, describe, expect, it } from 'vitest';
import {
  getComicReviewQueue,
  moderatorUnpublishComicChapter,
  setComicChapterNsfwLevel,
  setComicProjectNsfwLevel,
  updateComicChapter,
  updateComicChapterNsfwLevels,
  updateComicNsfwLevelsForImage,
  updateComicProject,
  updateComicProjectNsfwLevels,
} from './comic.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) the ported query against the live schema so a column/join/type that
// does not resolve against the real database fails here even though the compile-only test passed. Skips when
// no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('comics queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getComicReviewQueue (default branch) plans against the real schema', async () => {
    await getComicReviewQueue(h.db, { limit: 20 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getComicReviewQueue (specific needsReview) plans', async () => {
    await getComicReviewQueue(h.db, { limit: 20, needsReview: 'poi' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getComicReviewQueue (includeTosViolations=false) plans', async () => {
    await getComicReviewQueue(h.db, { limit: 20, includeTosViolations: false });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getComicReviewQueue (with cursor) plans', async () => {
    await getComicReviewQueue(h.db, { limit: 20, cursor: 555 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateComicProject plans (write, not executed)', async () => {
    await updateComicProject(h.db, { id: -1, tosViolation: true });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateComicChapter plans (write, not executed)', async () => {
    await updateComicChapter(h.db, { id: -1, status: 'Draft' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setComicProjectNsfwLevel plans', async () => {
    await setComicProjectNsfwLevel(h.db, { id: -1, nsfwLevel: 4 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setComicChapterNsfwLevel plans', async () => {
    await setComicChapterNsfwLevel(h.db, { projectId: -1, chapterPosition: 0, nsfwLevel: 4 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('moderatorUnpublishComicChapter plans', async () => {
    await moderatorUnpublishComicChapter(h.db, { projectId: -1, chapterPosition: 0 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateComicChapterNsfwLevels plans', async () => {
    await updateComicChapterNsfwLevels(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateComicProjectNsfwLevels plans', async () => {
    await updateComicProjectNsfwLevels(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateComicNsfwLevelsForImage panel-lookup plans', async () => {
    await updateComicNsfwLevelsForImage(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
