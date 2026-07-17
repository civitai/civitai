import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyIngestionErrorResolution,
  countImagesPendingIngestion,
  getImagesPendingIngestion,
  getIngestionErrorImages,
  getIngestionResults,
  resolveIngestionError,
} from './ingestion.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getImagesPendingIngestion', () => {
  it('selects pending images within the 5-day window, keyset on id, newest first', async () => {
    await getImagesPendingIngestion(harness.db, { cursor: 500, limit: 20 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "name", "url", "type", "createdAt", "metadata" from "Image" ' +
        'where "ingestion" = $1 and "createdAt" > $2 and "id" < $3 order by "id" desc limit $4'
    );
    expect(parameters[0]).toBe('Pending');
    expect(parameters[1]).toBeInstanceOf(Date); // the 5-day cutoff, computed in JS
    expect(parameters[2]).toBe(500); // cursor
    expect(parameters[3]).toBe(21); // limit + 1 (fetch one extra to derive nextCursor)
  });

  it('omits the cursor predicate on the first page', async () => {
    await getImagesPendingIngestion(harness.db, { limit: 20 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).not.toContain('"id" <');
    expect(sql).toBe(
      'select "id", "name", "url", "type", "createdAt", "metadata" from "Image" ' +
        'where "ingestion" = $1 and "createdAt" > $2 order by "id" desc limit $3'
    );
    expect(parameters).toEqual(['Pending', expect.any(Date), 21]);
  });
});

describe('countImagesPendingIngestion', () => {
  it('counts the pending queue within the same window (no pagination)', async () => {
    await countImagesPendingIngestion(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select count(*) as "count" from "Image" where "ingestion" = $1 and "createdAt" > $2'
    );
    expect(parameters[0]).toBe('Pending');
    expect(parameters[1]).toBeInstanceOf(Date);
  });
});

describe('getIngestionErrorImages', () => {
  it('preserves the raw INTERVAL window, the enum cast, and the keyset cursor', async () => {
    await getIngestionErrorImages(harness.db, { limit: 10, cursor: 100 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain(`now() - INTERVAL '2 days'`);
    expect(sql).toContain(`now() - INTERVAL '1 hour'`);
    expect(sql).toContain(`i.ingestion = 'Error'::"ImageIngestionStatus"`);
    expect(sql).toContain(`i."nsfwLevel" = 0`);
    expect(sql).toContain('i.id < $1');
    expect(sql).toContain('LIMIT $2');
    expect(parameters).toEqual([100, 11]); // cursor, limit + 1
  });

  it('substitutes TRUE for the cursor predicate on the first page', async () => {
    await getIngestionErrorImages(harness.db, { limit: 10 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).not.toContain('i.id <');
    expect(sql).toContain('TRUE');
    expect(sql).toContain('LIMIT $1');
    expect(parameters).toEqual([11]);
  });
});

describe('applyIngestionErrorResolution', () => {
  it('pins the nsfwLevel, marks Scanned, and writes merged jsonb metadata, then rolls up the post', async () => {
    await applyIngestionErrorResolution(harness.db, {
      id: 42,
      nsfwLevel: 4,
      postId: 7,
      existingMetadata: { existing: true },
    });

    expect(harness.queries).toHaveLength(2);
    const update = harness.queries[0];
    expect(update.sql).toBe(
      'update "Image" set "nsfwLevel" = $1, "nsfwLevelLocked" = $2, "ingestion" = $3, ' +
        '"scannedAt" = $4, "metadata" = $5::jsonb, "updatedAt" = $6 where "id" = $7'
    );
    expect(update.parameters[0]).toBe(4);
    expect(update.parameters[1]).toBe(true);
    expect(update.parameters[2]).toBe('Scanned');
    expect(update.parameters[3]).toBeInstanceOf(Date);
    expect(update.parameters[4]).toBe(
      JSON.stringify({ existing: true, nsfwLevelReason: 'Moderator ingestion error review' })
    );
    expect(update.parameters[5]).toBeInstanceOf(Date); // updatedAt, plugin-stamped
    expect(update.parameters[6]).toBe(42);

    const rollup = harness.queries[1];
    expect(rollup.sql).toBe('SELECT update_post_nsfw_levels(ARRAY[$1]::int[])');
    expect(rollup.parameters).toEqual([7]);
  });

  it('skips the post roll-up when the image has no post', async () => {
    await applyIngestionErrorResolution(harness.db, {
      id: 42,
      nsfwLevel: 4,
      postId: null,
      existingMetadata: null,
    });

    expect(harness.queries).toHaveLength(1);
    expect(harness.queries[0].sql).toContain('update "Image"');
    expect(harness.lastQuery().sql).not.toContain('update_post_nsfw_levels');
  });
});

describe('getIngestionResults', () => {
  it('short-circuits an empty id list without touching the DB', async () => {
    const result = await getIngestionResults(harness.db, { ids: [] });
    expect(result).toEqual({});
    expect(harness.queries).toHaveLength(0);
  });

  it('reads images then composite tags (score > 0 or Moderation, score desc), no votes without userId', async () => {
    await getIngestionResults(harness.db, { ids: [1, 2, 3] });

    expect(harness.queries).toHaveLength(2);
    expect(harness.queries[0].sql).toBe(
      'select "id", "ingestion", "blockedFor" from "Image" where "id" in ($1, $2, $3)'
    );
    expect(harness.queries[0].parameters).toEqual([1, 2, 3]);

    const tags = harness.queries[1];
    expect(tags.sql).toBe(
      'select "imageId", "tagId", "tagName", "tagType", "tagNsfwLevel", "score", "upVotes", ' +
        '"downVotes", "automated", "needsReview", "concrete", "lastUpvote", "source" ' +
        'from "ImageTag" where "imageId" in ($1, $2, $3) and ("score" > $4 or "tagType" = $5) ' +
        'order by "score" desc'
    );
    expect(tags.parameters).toEqual([1, 2, 3, 0, 'Moderation']);
  });

  it('reads the caller votes when userId is given', async () => {
    await getIngestionResults(harness.db, { ids: [1, 2], userId: 99 });

    expect(harness.queries).toHaveLength(3);
    const votes = harness.lastQuery();
    expect(votes.sql).toBe(
      'select "tagId", "vote" from "TagsOnImageVote" where "imageId" in ($1, $2) and "userId" = $3'
    );
    expect(votes.parameters).toEqual([1, 2, 99]);
  });
});

describe('resolveIngestionError', () => {
  it('reads the image (post + metadata) first, throwing when it is missing', async () => {
    // The offline driver returns no rows, so the read-guard fires — which lets us assert the read query.
    await expect(
      resolveIngestionError(harness.db, { id: 42, nsfwLevel: 4, userId: 99 })
    ).rejects.toThrow('Image not found');
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select "postId", "metadata" from "Image" where "id" = $1');
    expect(parameters).toEqual([42]);
  });
});
