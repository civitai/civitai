import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { imageReviewedSql, isImageReviewed } from '~/server/common/image-visibility';
import type { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

type Row = {
  ingestion: ImageIngestionStatus;
  nsfwLevelLocked: boolean;
  scanJobs: Record<string, unknown> | null;
};

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL,
      "nsfwLevelLocked" boolean NOT NULL, metadata jsonb, "scanJobs" jsonb
    );
  `);
});
afterAll(() => db.close());
beforeEach(() => db.exec(`TRUNCATE "Image"`));

/** Both encodings' verdict on one row; they must agree. */
const reviewed = async (row: Row) => {
  await db.query(
    `INSERT INTO "Image" (id, ingestion, "nsfwLevelLocked", "scanJobs") VALUES (1, $1, $2, $3)`,
    [row.ingestion, row.nsfwLevelLocked, row.scanJobs ? JSON.stringify(row.scanJobs) : null]
  );
  const sql = imageReviewedSql();
  const { rows } = await db.query<{ reviewed: boolean }>(
    `SELECT ${sql.text} AS reviewed FROM "Image" i WHERE i.id = 1`,
    sql.values
  );
  const ts = isImageReviewed({ ...row, nsfwLevelReason: null });
  expect(ts, 'isImageReviewed agrees with imageReviewedSql').toBe(rows[0].reviewed);
  return rows[0].reviewed;
};

const locked = { nsfwLevelLocked: true };

describe('a moderator lock on an errored scan', () => {
  it('is not reviewed once a re-submit moved a permanent failure to lastFailure', async () => {
    expect(
      await reviewed({
        ingestion: 'Error',
        ...locked,
        scanJobs: {
          error: { failureClass: 'transient' },
          lastFailure: { failureClass: 'permanent' },
        },
      })
    ).toBe(false);
  });

  it('is not reviewed when the current error is permanent', async () => {
    expect(
      await reviewed({
        ingestion: 'Error',
        ...locked,
        scanJobs: { error: { failureClass: 'permanent' } },
      })
    ).toBe(false);
  });

  it('is reviewed when no failure was permanent', async () => {
    expect(
      await reviewed({
        ingestion: 'Error',
        ...locked,
        scanJobs: {
          error: { failureClass: 'transient' },
          lastFailure: { failureClass: 'transient' },
        },
      })
    ).toBe(true);
  });
});

describe('a completed scan', () => {
  it('is reviewed whatever an earlier failure was', async () => {
    expect(
      await reviewed({
        ingestion: 'Scanned',
        nsfwLevelLocked: false,
        scanJobs: { lastFailure: { failureClass: 'permanent' } },
      })
    ).toBe(true);
  });
});
