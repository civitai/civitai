import { beforeEach, describe, expect, it } from 'vitest';
import { getComicReviewQueue } from './comics.db';
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
