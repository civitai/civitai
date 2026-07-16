import { afterAll, describe, expect, it } from 'vitest';
import {
  getImageTosViolationReport,
  listComicProjectIdsForImages,
  listImageResourceModelVersions,
  listImageTagNames,
  listPostGalleryLinks,
} from './image-moderation-effects.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported read against the live schema. Validates that columns,
// joins, and the raw jsonb `->>` accessors resolve against the real database. Skips when no DB URL is set.
const h = explainHarness();

describe.skipIf(!h.hasDb)(
  'image-moderation-effects queries EXPLAIN against the real schema',
  () => {
    afterAll(() => h.destroy());

    it('listComicProjectIdsForImages plans', async () => {
      await listComicProjectIdsForImages(h.db, [-1, -2]);
      expect((await h.explainLast()).length).toBeGreaterThan(0);
    });

    it('listPostGalleryLinks plans', async () => {
      await listPostGalleryLinks(h.db, [-1, -2]);
      expect((await h.explainLast()).length).toBeGreaterThan(0);
    });

    it('listImageTagNames plans', async () => {
      await listImageTagNames(h.db, -1);
      expect((await h.explainLast()).length).toBeGreaterThan(0);
    });

    it('listImageResourceModelVersions plans', async () => {
      await listImageResourceModelVersions(h.db, -1);
      expect((await h.explainLast()).length).toBeGreaterThan(0);
    });

    it('getImageTosViolationReport plans (raw jsonb ->> query)', async () => {
      await getImageTosViolationReport(h.db, -1);
      expect((await h.explainLast()).length).toBeGreaterThan(0);
    });
  }
);
