import { beforeEach, describe, expect, it } from 'vitest';
import { getTagRules, upsertTagsOnImageNew } from './tags-on-image.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getTagRules', () => {
  it('reads the Replace/Append rules from the source table (cache fallback only)', async () => {
    await getTagRules(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "fromTagId" as "fromId", "toTagId" as "toId", "type" from "TagsOnTags" ' +
        'where "type" in ($1, $2)'
    );
    expect(parameters).toEqual(['Replace', 'Append']);
  });
});

describe('upsertTagsOnImageNew', () => {
  it('short-circuits on an empty args list WITHOUT running a query (no empty VALUES)', async () => {
    const result = await upsertTagsOnImageNew(harness.db, []);

    expect(result).toBeUndefined();
    expect(harness.queries).toHaveLength(0); // never emits `VALUES ()` — the guard the README requires
  });

  it('builds the VALUES list → upsert_tag_on_image, with each column cast', async () => {
    await upsertTagsOnImageNew(harness.db, [
      { imageId: 1, tagId: 10, source: 'Rekognition', confidence: 80, automated: true },
      { imageId: 2, tagId: 20, disabled: true, needsReview: false },
    ]);

    // Two statements are issued: the upsert VALUES call, then the nsfw recompute.
    expect(harness.queries).toHaveLength(2);
    const upsert = harness.queries[0];

    expect(upsert.sql).toContain('SELECT upsert_tag_on_image(');
    expect(upsert.sql).toContain(
      't."imageId", t."tagId", t."source", t."confidence", t."automated", t."disabled", t."needsReview"'
    );
    expect(upsert.sql).toContain(
      'FROM (VALUES ($1::int, $2::int, $3::"TagSource", $4::integer, $5::boolean, $6::boolean, $7::boolean), ' +
        '($8::int, $9::int, $10::"TagSource", $11::integer, $12::boolean, $13::boolean, $14::boolean)) ' +
        'AS t("imageId", "tagId", "source", "confidence", "automated", "disabled", "needsReview")'
    );
    expect(upsert.sql).not.toContain('VALUES ()');
    // Unset attribute fields serialize as NULL bind params (upsert_tag_on_image preserves them on conflict).
    expect(upsert.parameters).toEqual([
      1,
      10,
      'Rekognition',
      80,
      true,
      null,
      null,
      2,
      20,
      null,
      null,
      null,
      true,
      false,
    ]);
  });

  it('recomputes nsfwLevel for the distinct touched images via update_nsfw_levels_new', async () => {
    await upsertTagsOnImageNew(harness.db, [
      { imageId: 5, tagId: 1 },
      { imageId: 5, tagId: 2 },
      { imageId: 6, tagId: 3 },
    ]);

    const nsfw = harness.queries[harness.queries.length - 1];
    expect(nsfw.sql).toContain('SELECT update_nsfw_levels_new(ARRAY[$1::int, $2::int])');
    expect(nsfw.parameters).toEqual([5, 6]); // deduped imageIds
  });
});
