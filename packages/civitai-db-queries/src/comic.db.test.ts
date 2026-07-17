import { beforeEach, describe, expect, it } from 'vitest';
import {
  getComicReviewQueue,
  moderatorUnpublishComicChapter,
  setComicChapterNsfwLevel,
  setComicProjectNsfwLevel,
  updateComicChapter,
  updateComicChapterNsfwLevels,
  updateComicNsfwLevels,
  updateComicNsfwLevelsForImage,
  updateComicProject,
  updateComicProjectNsfwLevels,
} from './comic.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getComicReviewQueue', () => {
  it('builds the base join/select shape with the coalesce prompt and jsonb uploaded flag', async () => {
    await getComicReviewQueue(harness.db, { limit: 20 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('from "ComicPanel" as "p"');
    expect(sql).toContain('inner join "Image" as "i" on "i"."id" = "p"."imageId"');
    expect(sql).toContain('inner join "ComicProject" as "proj" on "proj"."id" = "p"."projectId"');
    expect(sql).toContain(
      'inner join "ComicChapter" as "ch" on "ch"."projectId" = "p"."projectId" and "ch"."position" = "p"."chapterPosition"'
    );
    expect(sql).toContain('inner join "User" as "u" on "u"."id" = "proj"."userId"');
    // Raw fragments preserved exactly.
    expect(sql).toContain(
      `COALESCE(NULLIF(p.prompt, ''), NULLIF(p."enhancedPrompt", ''), NULLIF(i.meta->>'prompt', ''))`
    );
    expect(sql).toContain(`(p.metadata->>'sourceImageUrl') IS NOT NULL`);
    expect(sql).toContain('order by "p"."id" desc');
    // limit is limit + 1 for the has-next probe.
    expect(parameters[parameters.length - 1]).toBe(21);
  });

  it('default branch: needsReview-is-not-null OR non-Scanned ingestion OR tosViolation', async () => {
    await getComicReviewQueue(harness.db, { limit: 20 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('"i"."needsReview" is not null');
    expect(sql).toContain('"i"."ingestion" != $1');
    expect(sql).toContain('"i"."tosViolation" = $2');
    expect(parameters).toEqual(['Scanned', true, 21]);
    expect(sql).not.toContain('"p"."id" <');
  });

  it('specific needsReview value narrows to that reason (still unioning tosViolation by default)', async () => {
    await getComicReviewQueue(harness.db, { limit: 20, needsReview: 'poi' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('"i"."needsReview" = $1');
    expect(sql).toContain('"i"."tosViolation" = $2');
    expect(sql).not.toContain('is not null');
    expect(sql).not.toContain('"i"."ingestion" !=');
    expect(parameters).toEqual(['poi', true, 21]);
  });

  it('includeTosViolations=false drops the tosViolation predicate (default reason branch)', async () => {
    await getComicReviewQueue(harness.db, { limit: 20, includeTosViolations: false });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('"i"."needsReview" is not null');
    expect(sql).toContain('"i"."ingestion" != $1');
    expect(sql).not.toContain('"i"."tosViolation" =');
    expect(parameters).toEqual(['Scanned', 21]);
  });

  it('needsReview + includeTosViolations=false narrows to a single needsReview predicate', async () => {
    await getComicReviewQueue(harness.db, {
      limit: 20,
      needsReview: 'poi',
      includeTosViolations: false,
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('"i"."needsReview" = $1');
    expect(sql).not.toContain('"i"."tosViolation" =');
    expect(sql).not.toContain('"i"."ingestion" !=');
    expect(parameters).toEqual(['poi', 21]);
  });

  it('applies the cursor predicate when a cursor is supplied', async () => {
    await getComicReviewQueue(harness.db, { limit: 10, cursor: 555 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('"p"."id" < $');
    // 'Scanned', true (tos), cursor 555, limit 11
    expect(parameters).toEqual(['Scanned', true, 555, 11]);
  });
});

describe('updateComicProject', () => {
  it('sets the given columns, auto-stamps updatedAt, returns all, keyed by id', async () => {
    await updateComicProject(harness.db, { id: 42, tosViolation: true });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "ComicProject" set "tosViolation" = $1, "updatedAt" = $2 where "id" = $3 returning *'
    );
    expect(parameters).toEqual([true, expect.any(Date), 42]);
  });
});

describe('updateComicChapter', () => {
  it('sets the given columns, auto-stamps updatedAt, returns all, keyed by id', async () => {
    await updateComicChapter(harness.db, { id: 7, status: 'Draft' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "ComicChapter" set "status" = $1, "updatedAt" = $2 where "id" = $3 returning *'
    );
    expect(parameters).toEqual(['Draft', expect.any(Date), 7]);
  });
});

describe('setComicProjectNsfwLevel', () => {
  it('stamps every panel image in the project with the chosen level (only differing rows)', async () => {
    await setComicProjectNsfwLevel(harness.db, { id: 42, nsfwLevel: 4 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('UPDATE "Image" i');
    expect(sql).toContain('FROM "ComicPanel" p');
    expect(sql).toContain('p."projectId" =');
    expect(sql).toContain('i."nsfwLevel" <>');
    expect(sql).not.toContain('chapterPosition');
    expect(parameters).toEqual([4, 42, 4]);
  });
});

describe('setComicChapterNsfwLevel', () => {
  it('stamps every panel image in the chapter with the chosen level', async () => {
    await setComicChapterNsfwLevel(harness.db, {
      projectId: 42,
      chapterPosition: 3,
      nsfwLevel: 4,
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('UPDATE "Image" i');
    expect(sql).toContain('p."chapterPosition" =');
    expect(parameters).toEqual([4, 42, 3, 4]);
  });
});

describe('moderatorUnpublishComicChapter', () => {
  it('flips chapter status → Draft keyed by (projectId, position) + updatedAt', async () => {
    await moderatorUnpublishComicChapter(harness.db, { projectId: 42, chapterPosition: 3 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "ComicChapter" set "status" = $1, "updatedAt" = $2 ' +
        'where "projectId" = $3 and "position" = $4'
    );
    expect(parameters).toEqual(['Draft', expect.any(Date), 42, 3]);
  });
});

describe('updateComicChapterNsfwLevels', () => {
  it('short-circuits an empty id list WITHOUT running a query (no IN ())', async () => {
    await updateComicChapterNsfwLevels(harness.db, []);
    expect(harness.queries).toHaveLength(0);
  });

  it('bit_or recompute of chapter levels from panel images', async () => {
    await updateComicChapterNsfwLevels(harness.db, [1, 2]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('bit_or(i."nsfwLevel")');
    expect(sql).toContain('UPDATE "ComicChapter" ch');
    expect(sql).toContain('ch."projectId" IN ($1, $2)');
    expect(sql).not.toContain('IN ()');
    expect(parameters).toEqual([1, 2]);
  });
});

describe('updateComicProjectNsfwLevels', () => {
  it('bit_or recompute of project levels from chapter levels', async () => {
    await updateComicProjectNsfwLevels(harness.db, [1, 2]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('bit_or("nsfwLevel")');
    expect(sql).toContain('UPDATE "ComicProject" cp');
    expect(sql).toContain('"projectId" IN ($1, $2)');
    expect(parameters).toEqual([1, 2]);
  });
});

describe('updateComicNsfwLevels', () => {
  it('runs chapter recompute BEFORE project recompute (ordered)', async () => {
    await updateComicNsfwLevels(harness.db, [1, 2]);

    expect(harness.queries).toHaveLength(2);
    expect(harness.queries[0].sql).toContain('UPDATE "ComicChapter" ch');
    expect(harness.queries[1].sql).toContain('UPDATE "ComicProject" cp');
  });

  it('short-circuits an empty id list entirely', async () => {
    await updateComicNsfwLevels(harness.db, []);
    expect(harness.queries).toHaveLength(0);
  });
});

describe('updateComicNsfwLevelsForImage', () => {
  it('resolves the distinct project ids for the image, then recomputes', async () => {
    await updateComicNsfwLevelsForImage(harness.db, 555);
    // Only the panel lookup runs against the DummyDriver (it resolves to an
    // empty set, so the recompute short-circuits with no project ids).
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select distinct "projectId" from "ComicPanel" where "imageId" = $1');
    expect(parameters).toEqual([555]);
    expect(harness.queries).toHaveLength(1);
  });
});
