import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { imageReviewedSql, isImageReviewed } from '~/server/common/image-visibility';
import type { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

type Row = {
  ingestion: ImageIngestionStatus;
  nsfwLevelLocked: boolean;
  scanJobs: Record<string, unknown> | null;
};

/**
 * feed-go's `ImageReviewedSQL("i")`, the Go copy of `imageReviewedSql`, rendered from its source:
 * the raw-string literals of its return expression, with each `a` (the quoted alias) between them.
 */
const feedGoImageReviewedSql = (() => {
  const source = readFileSync(
    join(process.cwd(), 'apps/feed-go/internal/hydrate/users.go'),
    'utf8'
  );
  const fn = source.slice(source.indexOf('func ImageReviewedSQL('));
  const body = fn.slice(fn.indexOf('return '), fn.indexOf('\n}'));
  return [...body.matchAll(/`([^`]*)`|\ba\b/g)]
    .map(([token, literal]) => (token === 'a' ? '"i"' : literal))
    .join('');
})();

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "TextScanHold" ("entityType" text, "entityId" int, label text, status text);
    CREATE TABLE "Image" (
      type "MediaType" NOT NULL DEFAULT 'image',
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

/** All three encodings' verdict on the stored row; they must agree. */
const storedReviewed = async () => {
  const sql = imageReviewedSql();
  const { rows } = await db.query<Row & { reviewed: boolean; feedGo: boolean }>(
    `SELECT ingestion, "nsfwLevelLocked", "scanJobs", ${sql.text} AS reviewed,
       ${feedGoImageReviewedSql} AS "feedGo"
     FROM "Image" i WHERE i.id = 1`,
    sql.values
  );
  const { reviewed, feedGo, ...row } = rows[0];
  const ts = isImageReviewed({ ...row, nsfwLevelReason: null });
  expect(ts, 'isImageReviewed agrees with imageReviewedSql').toBe(reviewed);
  expect(feedGo, "feed-go's ImageReviewedSQL agrees with imageReviewedSql").toBe(reviewed);
  return reviewed;
};

const reviewed = async (row: Row) => {
  await insert(row);
  return storedReviewed();
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

describe("feed-go's ImageReviewedSQL", () => {
  it.each([
    [
      'a transient error after a permanent lastFailure',
      { error: { failureClass: 'transient' }, lastFailure: { failureClass: 'permanent' } },
      'Error',
      false,
    ],
    ['a permanent error', { error: { failureClass: 'permanent' } }, 'Error', false],
    [
      'a completed scan after a permanent lastFailure',
      { lastFailure: { failureClass: 'permanent' } },
      'Scanned',
      true,
    ],
    [
      'a kept permanent failure',
      { error: { failureClass: 'transient' }, permanentFailure: true },
      'Error',
      false,
    ],
    ['a transient error', { error: { failureClass: 'transient' } }, 'Error', true],
    ['no scanJobs', null, 'Error', true],
  ] as const)('decides %s like the TS encodings', async (_label, scanJobs, ingestion, expected) => {
    expect(await reviewed({ ingestion, ...locked, scanJobs })).toBe(expected);
  });
});
