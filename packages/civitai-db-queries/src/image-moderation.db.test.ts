import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteImageTagsForReview,
  getImageAppeal,
  getImageForBlock,
  getImageForModeration,
  getImagePostId,
  getImageTagsForReview,
  getPendingImageAppealAppellants,
  recomputeImageNsfwLevel,
  setImageAccepted,
  setImageAppealRejected,
  setImageAppealRestored,
  setImageAppealStatus,
  setImageBlocked,
  setImageNsfwLevel,
  setImageRatingRequestsResolved,
} from './image-moderation.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('reads', () => {
  it('getImageForModeration selects the accept fields for one image', async () => {
    await getImageForModeration(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('select "needsReview", "pHash", "postId" from "Image" where "id" = $1');
    expect(parameters).toEqual([42]);
  });

  it('getImageForBlock selects the pre-block snapshot fields', async () => {
    await getImageForBlock(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "needsReview", "pHash", "blockedFor", "postId", "nsfwLevel", "userId" ' +
        'from "Image" where "id" = $1'
    );
    expect(parameters).toEqual([42]);
  });

  it('getImagePostId selects only postId', async () => {
    await getImagePostId(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('select "postId" from "Image" where "id" = $1');
    expect(parameters).toEqual([42]);
  });

  it('getImageTagsForReview lists the review tag ids', async () => {
    await getImageTagsForReview(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('select "tagId" from "ImageTagForReview" where "imageId" = $1');
    expect(parameters).toEqual([42]);
  });

  it('getImageAppeal reads the pending appeal fields, scoped to Image + Pending', async () => {
    await getImageAppeal(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "id", "userId", "buzzTransactionId" from "Appeal" ' +
        'where "entityType" = $1 and "entityId" = $2 and "status" = $3'
    );
    expect(parameters).toEqual(['Image', 42, 'Pending']);
  });
});

describe('getPendingImageAppealAppellants', () => {
  it('short-circuits an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await getPendingImageAppealAppellants(harness.db, []);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('reads userId/entityId for the pending appeals of the given images', async () => {
    await getPendingImageAppealAppellants(harness.db, [1, 2, 3]);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "userId", "entityId" from "Appeal" ' +
        'where "entityType" = $1 and "entityId" in ($2, $3, $4) and "status" = $5'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual(['Image', 1, 2, 3, 'Pending']);
  });
});

describe('setImageAccepted', () => {
  it('default accept (non-special needsReview): clears flags, strips rule keys, no poi/minor/scannedAt', async () => {
    await setImageAccepted(harness.db, { imageId: 42, needsReview: 'tag' });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'update "Image" set "needsReview" = $1, "blockedFor" = $2, "ingestion" = $3, ' +
        `"metadata" = "metadata" - 'ruleId' - 'ruleReason' where "id" = $4`
    );
    expect(parameters).toEqual([null, null, 'Scanned', 42]);
    expect(sql).not.toContain('"poi"');
    expect(sql).not.toContain('"minor"');
    expect(sql).not.toContain('"scannedAt"');
  });

  it('remixSource: strips rule keys AND stamps remixSourceReviewed via COALESCE || merge', async () => {
    await setImageAccepted(harness.db, { imageId: 42, needsReview: 'remixSource' });
    const { sql } = harness.lastQuery();
    expect(sql).toContain(
      `"metadata" = (COALESCE("metadata", '{}'::jsonb) - 'ruleId' - 'ruleReason') || '{"remixSourceReviewed": true}'::jsonb`
    );
  });

  it('poi: clears poi and stamps scannedAt = now()', async () => {
    await setImageAccepted(harness.db, { imageId: 42, needsReview: 'poi' });
    const { sql } = harness.lastQuery();
    expect(sql).toContain('"poi" = $');
    expect(sql).toContain('"scannedAt" = now()');
  });

  it('minor default: auto-clears minor for mature content via CASE nsfwLevel', async () => {
    await setImageAccepted(harness.db, { imageId: 42, needsReview: 'minor' });
    const { sql } = harness.lastQuery();
    expect(sql).toContain('"minor" = CASE WHEN "nsfwLevel" >= 4 THEN FALSE ELSE TRUE END');
    expect(sql).toContain('"scannedAt" = now()');
  });

  it('minor + removeMinorFlag: force-clears minor to false (bound param, no CASE)', async () => {
    await setImageAccepted(harness.db, {
      imageId: 42,
      needsReview: 'minor',
      removeMinorFlag: true,
    });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toContain('"minor" = $');
    expect(sql).not.toContain('CASE WHEN');
    expect(parameters).toContain(false);
  });
});

describe('deleteImageTagsForReview', () => {
  it('deletes the review tags for one image', async () => {
    await deleteImageTagsForReview(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('delete from "ImageTagForReview" where "imageId" = $1');
    expect(parameters).toEqual([42]);
  });
});

describe('setImageBlocked', () => {
  it('soft-hides the image: Blocked ingestion + nsfwLevel + blockedFor + updatedAt', async () => {
    await setImageBlocked(harness.db, { imageId: 42, needsReview: 'tag' });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'update "Image" set "needsReview" = $1, "ingestion" = $2, "nsfwLevel" = $3, ' +
        '"blockedFor" = $4, "updatedAt" = $5 where "id" = $6'
    );
    expect(parameters[0]).toBeNull();
    expect(parameters[1]).toBe('Blocked');
    expect(parameters[2]).toBe(32); // NsfwLevel.Blocked
    expect(parameters[3]).toBe('moderated');
    expect(parameters[4]).toBeInstanceOf(Date);
    expect(parameters[5]).toBe(42);
  });

  it('remixSource: also stamps remixSourceReviewed via COALESCE || merge', async () => {
    await setImageBlocked(harness.db, { imageId: 42, needsReview: 'remixSource' });
    const { sql } = harness.lastQuery();
    expect(sql).toContain(
      `"metadata" = COALESCE("metadata", '{}'::jsonb) || '{"remixSourceReviewed": true}'::jsonb`
    );
  });
});

describe('recomputeImageNsfwLevel', () => {
  it('calls the update_nsfw_levels_new stored proc with ARRAY[id::int]', async () => {
    await recomputeImageNsfwLevel(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('SELECT update_nsfw_levels_new(ARRAY[$1::int])');
    expect(parameters).toEqual([42]);
  });
});

describe('setImageAppealStatus', () => {
  it('closes the pending appeal without resolvedMessage when omitted', async () => {
    await setImageAppealStatus(harness.db, { imageId: 42, status: 'Approved', userId: 7 });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'update "Appeal" set "status" = $1, "resolvedBy" = $2, "resolvedAt" = $3 ' +
        'where "entityType" = $4 and "entityId" = $5 and "status" = $6'
    );
    expect(sql).not.toContain('resolvedMessage');
    expect(parameters).toEqual(['Approved', 7, expect.any(Date), 'Image', 42, 'Pending']);
  });

  it('includes resolvedMessage when provided (even null)', async () => {
    await setImageAppealStatus(harness.db, {
      imageId: 42,
      status: 'Rejected',
      userId: 7,
      resolvedMessage: null,
    });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toContain('"resolvedMessage" = $4');
    expect(parameters).toEqual(['Rejected', 7, expect.any(Date), null, 'Image', 42, 'Pending']);
  });
});

describe('setImageAppealRestored / setImageAppealRejected', () => {
  it('restored clears review flag + blockedFor and returns to Scanned', async () => {
    await setImageAppealRestored(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'update "Image" set "needsReview" = $1, "blockedFor" = $2, "ingestion" = $3 where "id" = $4'
    );
    expect(parameters).toEqual([null, null, 'Scanned', 42]);
  });

  it('rejected clears only the review flag', async () => {
    await setImageAppealRejected(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('update "Image" set "needsReview" = $1 where "id" = $2');
    expect(parameters).toEqual([null, 42]);
  });
});

describe('setImageNsfwLevel / setImageRatingRequestsResolved', () => {
  it('setImageNsfwLevel pins nsfwLevel and locks it', async () => {
    await setImageNsfwLevel(harness.db, { id: 42, nsfwLevel: 4 });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe('update "Image" set "nsfwLevel" = $1, "nsfwLevelLocked" = $2 where "id" = $3');
    expect(parameters).toEqual([4, true, 42]);
  });

  it('setImageRatingRequestsResolved transitions pending requests for the image', async () => {
    await setImageRatingRequestsResolved(harness.db, { imageId: 42, status: 'Actioned' });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'update "ImageRatingRequest" set "status" = $1 where "imageId" = $2 and "status" = $3'
    );
    expect(parameters).toEqual(['Actioned', 42, 'Pending']);
  });
});
