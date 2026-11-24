import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * A strike issued with a removal skips service review images: their owner is the buyer who posted
 * them. Whatever the form posts, the removal still goes through and no strike reaches that owner.
 */

const { dbHandle, issueStrike, removeImages } = vi.hoisted(() => ({
  dbHandle: { current: null as unknown },
  issueStrike: vi.fn(async (_input: { userId: number }) => ({ ok: true as const })),
  removeImages: vi.fn(async (_input: { imageIds: number[] }) => ({
    ok: true as const,
    count: 0,
    held: [],
  })),
}));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../user-actions.service', () => ({ issueStrike, removeImages, setImageFlag: vi.fn() }));

const { removeImagesWithFollowUps, strikeBatchOwners } = await import('../bulk-image.service');

const BUYER = 990000002;
const OTHER = 990000003;
const REVIEW_IMAGE = 990000010;
const BUYER_OWN = 990000011;
const OTHER_IMAGE = 990000012;

let db: PGlite;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await freshPglite();
  await db.exec(`
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "ingestion" TEXT);
    CREATE TABLE "ServiceDealReviewImage" ("reviewId" INTEGER NOT NULL, "imageId" INTEGER NOT NULL);
    INSERT INTO "Image" VALUES
      (${REVIEW_IMAGE}, ${BUYER}, 'Scanned'), (${BUYER_OWN}, ${BUYER}, 'Scanned'),
      (${OTHER_IMAGE}, ${OTHER}, 'Scanned');
    INSERT INTO "ServiceDealReviewImage" VALUES (990000071, ${REVIEW_IMAGE});
  `);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const struckUsers = () => issueStrike.mock.calls.map(([input]) => input.userId);
const strike = (imageIds: number[]) =>
  strikeBatchOwners({ imageIds, description: 'd', moderatorId: 9 });

describe('a service review image never strikes its owner', () => {
  it("strikes an ordinary image's owner (control)", async () => {
    expect(await strike([OTHER_IMAGE])).toMatchObject({ struck: 1, reviewImagesSkipped: 0 });
    expect(struckUsers()).toEqual([OTHER]);
  });

  it('writes no strike for a service review image', async () => {
    expect(await strike([REVIEW_IMAGE])).toEqual({
      struck: 0,
      owners: 0,
      capturesSkipped: 0,
      reviewImagesSkipped: 1,
    });
    expect(issueStrike).not.toHaveBeenCalled();
  });

  it('strikes the other owners in a mixed batch, and the buyer only for their own image', async () => {
    expect(await strike([REVIEW_IMAGE, OTHER_IMAGE])).toMatchObject({ reviewImagesSkipped: 1 });
    expect(struckUsers()).toEqual([OTHER]);
    issueStrike.mockClear();
    await strike([REVIEW_IMAGE, BUYER_OWN]);
    expect(struckUsers()).toEqual([BUYER]);
  });

  it('removes a review image with a forged strike flag, and strikes no one', async () => {
    const result = await removeImagesWithFollowUps({
      imageIds: [REVIEW_IMAGE],
      reason: 'r',
      strikeOwners: true,
      moderatorId: 9,
    });
    expect(removeImages).toHaveBeenCalledWith(
      expect.objectContaining({ imageIds: [REVIEW_IMAGE] })
    );
    expect(result).toMatchObject({ ok: true, struck: { struck: 0, reviewImagesSkipped: 1 } });
    expect(issueStrike).not.toHaveBeenCalled();
  });
});
