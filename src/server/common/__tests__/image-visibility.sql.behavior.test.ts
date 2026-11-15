import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  imageReviewedSql,
  isImageReviewed,
  keepPermanentScanFailureSql,
} from '~/server/common/image-visibility';
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

const insert = (row: Row) =>
  db.query(
    `INSERT INTO "Image" (id, ingestion, "nsfwLevelLocked", "scanJobs") VALUES (1, $1, $2, $3)`,
    [row.ingestion, row.nsfwLevelLocked, row.scanJobs ? JSON.stringify(row.scanJobs) : null]
  );

/** Both encodings' verdict on the stored row; they must agree. */
const storedReviewed = async () => {
  const sql = imageReviewedSql();
  const { rows } = await db.query<Row & { reviewed: boolean }>(
    `SELECT ingestion, "nsfwLevelLocked", "scanJobs", ${sql.text} AS reviewed
     FROM "Image" i WHERE i.id = 1`,
    sql.values
  );
  const { reviewed, ...row } = rows[0];
  const ts = isImageReviewed({ ...row, nsfwLevelReason: null });
  expect(ts, 'isImageReviewed agrees with imageReviewedSql').toBe(reviewed);
  return reviewed;
};

const reviewed = async (row: Row) => {
  await insert(row);
  return storedReviewed();
};

// The writes that drop or replace error / lastFailure, as image.service and the ingest cron run them.
const resubmit = () => {
  const keep = keepPermanentScanFailureSql();
  return db.query(
    `UPDATE "Image" SET ingestion = 'Error', "scanJobs" = '{"workflowId": "w"}'::jsonb
       || jsonb_strip_nulls(jsonb_build_object(
         'lastFailure', COALESCE("scanJobs"->'error', "scanJobs"->'lastFailure')
       )) || ${keep.text}
     WHERE id = 1`,
    keep.values
  );
};
const cronFlipToError = () => {
  const keep = keepPermanentScanFailureSql();
  return db.query(
    `UPDATE "Image" SET ingestion = 'Error',
       "scanJobs" = ("scanJobs" - 'lastFailure') || ${keep.text}
     WHERE id = 1`,
    keep.values
  );
};
const fail = (failureClass: string) =>
  db.query(
    `UPDATE "Image" SET ingestion = 'Error',
       "scanJobs" = jsonb_set("scanJobs", '{error}', jsonb_build_object('failureClass', $1::text))
     WHERE id = 1`,
    [failureClass]
  );
/** A failure stamp as markImageScanError / markImageScanSubmitFailure write it. */
const failKeeping = (failureClass: string) => {
  const keep = keepPermanentScanFailureSql();
  const at = keep.values.length + 1;
  return db.query(
    `UPDATE "Image" SET ingestion = 'Error',
       "scanJobs" = jsonb_set(
         "scanJobs", '{error}', jsonb_build_object('failureClass', $${at}::text)
       ) || ${keep.text}
     WHERE id = 1`,
    [...keep.values, failureClass]
  );
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

describe('a permanent failure across later writes', () => {
  const permanentlyFailed = {
    ingestion: 'Error',
    ...locked,
    scanJobs: { error: { failureClass: 'permanent' } },
  } as const;

  it('stays not reviewed when the ingest cron drops lastFailure', async () => {
    await insert(permanentlyFailed);
    await resubmit();
    await cronFlipToError();
    expect(await storedReviewed()).toBe(false);
  });

  it('stays not reviewed after a second re-submit replaces lastFailure', async () => {
    await insert(permanentlyFailed);
    await resubmit();
    await fail('transient');
    await resubmit();
    expect(await storedReviewed()).toBe(false);
  });

  it('stays not reviewed when a later error replaces a permanent one', async () => {
    await insert(permanentlyFailed);
    await failKeeping('transient');
    expect(await storedReviewed()).toBe(false);
  });

  it('is not kept for a history with no permanent failure', async () => {
    await insert({ ...permanentlyFailed, scanJobs: { error: { failureClass: 'transient' } } });
    await resubmit();
    await cronFlipToError();
    expect(await storedReviewed()).toBe(true);
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
