import { beforeEach, describe, expect, it } from 'vitest';
import {
  getAppealImageQueue,
  getImageReviewCounts,
  getImageReviewQueue,
  getModerationRuleDefinitions,
  getReportedImageQueue,
  getReviewQueueTags,
} from './image-review.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getImageReviewQueue', () => {
  it('builds the queue query: lateral ImageConnection, jsonb extracts, browsing-level bit-op, tag EXISTS/NOT EXISTS, cursor', async () => {
    await getImageReviewQueue(harness.db, {
      needsReview: 'minor',
      tagIds: [1, 2],
      excludedTagIds: [3, 4],
      browsingLevel: 5,
      cursor: 1000,
      limit: 50,
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('from "Image" as "i"');
    expect(sql).toContain('inner join "User" as "u" on "u"."id" = "i"."userId"');
    expect(sql).toContain('left join "Post" as "p" on "p"."id" = "i"."postId"');
    // LATERAL LIMIT-1 ImageConnection
    expect(sql).toContain('left join lateral');
    expect(sql).toContain('from "ImageConnection" as "c"');
    // jsonb extracts preserved byte-for-byte
    expect(sql).toContain(`i.metadata ->> 'ruleReason'`);
    expect(sql).toContain(`(i.metadata ->> 'ruleId')::int`);
    expect(sql).toContain(`(i.metadata ->> 'profilePicture')::boolean`);
    expect(sql).toContain(`i.meta ->> 'prompt'`);
    expect(sql).toContain(`i.meta ->> 'negativePrompt'`);
    // browsing-level bitmask
    expect(sql).toContain('(i."nsfwLevel" = 0 OR (i."nsfwLevel" &');
    // tag include/exclude correlated subqueries
    expect(sql).toContain(
      'EXISTS (SELECT 1 FROM "TagsOnImageDetails" toi WHERE toi."imageId" = i.id'
    );
    expect(sql).toContain(
      'NOT EXISTS (SELECT 1 FROM "ImageTagForReview" toi WHERE toi."imageId" = i.id'
    );
    expect(sql).toContain('order by "i"."id" desc');
    // needsReview + ingestion + cursor
    expect(sql).toContain('"i"."needsReview" = ');
    expect(sql).toContain('"i"."ingestion" = ');
    expect(sql).toContain('"i"."id" < ');
    // params include browsingLevel, tag ids, excluded tag ids, needsReview, ingestion, cursor, limit+1
    expect(parameters).toContain('minor');
    expect(parameters).toContain('Scanned');
    expect(parameters).toContain(1000);
    expect(parameters).toContain(51); // limit + 1
    // no second (tags) query — DummyDriver returns an empty page, so ids is empty
    expect(harness.queries).toHaveLength(1);
  });

  it('omits the tag EXISTS/NOT EXISTS and cursor predicates when those filters are absent', async () => {
    await getImageReviewQueue(harness.db, { needsReview: 'tag', browsingLevel: 1, limit: 20 });
    const { sql } = harness.lastQuery();

    expect(sql).not.toContain('EXISTS (SELECT 1 FROM "TagsOnImageDetails"');
    expect(sql).not.toContain('NOT EXISTS');
    expect(sql).not.toContain('"i"."id" < ');
    expect(sql).toContain('"i"."needsReview" = ');
  });
});

describe('getModerationRuleDefinitions', () => {
  it('short-circuits an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await getModerationRuleDefinitions(harness.db, []);

    expect(result).toEqual({});
    expect(harness.queries).toHaveLength(0);
  });

  it('dedupes ids and selects definition by id', async () => {
    await getModerationRuleDefinitions(harness.db, [5, 5, 6]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select "id", "definition" from "ModerationRule" where "id" in ($1, $2)');
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([5, 6]);
  });
});

describe('getReviewQueueTags', () => {
  it('selects distinct tags for a queue, ordered by name, capped at 100', async () => {
    await getReviewQueueTags(harness.db, 'newUser');
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('select distinct "t"."id", "t"."name"');
    expect(sql).toContain('from "ImageTagForReview" as "itr"');
    expect(sql).toContain('inner join "Tag" as "t" on "t"."id" = "itr"."tagId"');
    expect(sql).toContain('inner join "Image" as "i" on "i"."id" = "itr"."imageId"');
    expect(sql).toContain('"i"."needsReview" = ');
    expect(sql).toContain('order by "t"."name"');
    expect(sql).toContain('limit $2');
    expect(parameters).toEqual(['newUser', 100]);
  });
});

describe('getImageReviewCounts', () => {
  it('groups counts by needsReview, excluding null/appeal and unscanned', async () => {
    await getImageReviewCounts(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('select "needsReview", count(*) as "count" from "Image"');
    expect(sql).toContain('"needsReview" is not null');
    expect(sql).toContain('"needsReview" != $1');
    expect(sql).toContain('"ingestion" = $2');
    expect(sql).toContain('group by "needsReview"');
    expect(parameters).toEqual(['appeal', 'Scanned']);
  });
});

describe('getReportedImageQueue', () => {
  it('joins ImageReport→Report→reporter, filters pending + browsing level, ordered by report id asc, array_length count', async () => {
    await getReportedImageQueue(harness.db, { browsingLevel: 3, cursor: 42, limit: 25 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('from "Image" as "i"');
    expect(sql).toContain('inner join "ImageReport" as "imgr" on "imgr"."imageId" = "i"."id"');
    expect(sql).toContain('inner join "Report" as "r" on "r"."id" = "imgr"."reportId"');
    expect(sql).toContain('inner join "User" as "ru" on "ru"."id" = "r"."userId"');
    expect(sql).toContain('coalesce(array_length(r."alsoReportedBy", 1), 0)');
    expect(sql).toContain('(i."nsfwLevel" = 0 OR (i."nsfwLevel" &');
    expect(sql).toContain('"r"."status" = ');
    expect(sql).toContain('"r"."id" > '); // cursor is ASC → greater-than
    expect(sql).toContain('order by "r"."id" asc');
    expect(parameters).toContain('Pending');
    expect(parameters).toContain(42);
    expect(parameters).toContain(26); // limit + 1
  });

  it('omits the cursor predicate when no cursor is given', async () => {
    await getReportedImageQueue(harness.db, { browsingLevel: 1, limit: 10 });
    const { sql } = harness.lastQuery();
    expect(sql).not.toContain('"r"."id" > ');
  });
});

describe('getAppealImageQueue', () => {
  it('builds the appeal queue: lateral newest Appeal, ModActivity review join, browsing level, needsReview=appeal', async () => {
    await getAppealImageQueue(harness.db, { browsingLevel: 7, cursor: 900, limit: 15 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('from "Image" as "i"');
    // lateral newest Appeal per image
    expect(sql).toContain('inner join lateral');
    expect(sql).toContain('from "Appeal" as "a"');
    expect(sql).toContain('"a"."entityType" = ');
    expect(sql).toContain('order by "a"."createdAt" desc');
    // ModActivity review join
    expect(sql).toContain('left join "ModActivity" as "ma"');
    expect(sql).toContain('"ma"."activity" = ');
    expect(sql).toContain('left join "User" as "mu" on "mu"."id" = "ma"."userId"');
    // browsing-level + needsReview + cursor
    expect(sql).toContain('(i."nsfwLevel" = 0 OR (i."nsfwLevel" &');
    expect(sql).toContain('"i"."needsReview" = ');
    expect(sql).toContain('"i"."id" < ');
    expect(sql).toContain('order by "i"."id" desc');
    expect(parameters).toContain('Image');
    expect(parameters).toContain('appeal');
    expect(parameters).toContain('review');
    expect(parameters).toContain(900);
    expect(parameters).toContain(16); // limit + 1
    // no second (reports) query — empty page
    expect(harness.queries).toHaveLength(1);
  });
});
