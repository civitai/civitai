import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  blockMarkerText,
  NSFW_BROWSING_LEVELS_FLAG,
  PERMANENT_SCAN_FAILURE,
  servablePictureParameters,
  servablePictureText,
} from '@civitai/db-queries/profile-picture-clear';
import { hasBlockMarkerSql } from '~/server/common/image-visibility';
import { ImageScanFailureClass } from '~/server/services/image-scan-failure';
import { servableProfilePictureSql } from '~/server/services/profile-picture.sql';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

// The moderator app runs the shared restore text, so it has to match the main app's predicates on
// every combination of the columns they read.
let pg: PGlite;

const ids = async (sql: Prisma.Sql) =>
  (await pg.query<{ id: number }>(sql.text, sql.values as unknown[])).rows.map((row) => row.id);
const idsText = async (where: string, parameters: unknown[]) =>
  (
    await pg.query<{ id: number }>(
      `SELECT i.id FROM "Image" i WHERE cardinality($1::int[]) >= 0 AND ${where} ORDER BY i.id`,
      [[], ...parameters]
    )
  ).rows.map((row) => row.id);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Image" (
      id serial PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL, "nsfwLevel" int NOT NULL,
      "needsReview" text, "nsfwLevelLocked" boolean NOT NULL, metadata jsonb, "scanJobs" jsonb,
      "modelRestricted" boolean NOT NULL, "blockedFor" text, "userId" int NOT NULL DEFAULT 1
    );
    INSERT INTO "Image" (ingestion, "nsfwLevel", "needsReview", "nsfwLevelLocked", metadata, "scanJobs", "modelRestricted", "blockedFor")
    SELECT ingestion, level, review, locked, metadata, scan, restricted, blocked
    FROM unnest(enum_range(NULL::"ImageIngestionStatus")) ingestion
    CROSS JOIN (VALUES (0), (1), (2), (4), (8), (16), (32)) levels(level)
    CROSS JOIN (VALUES (NULL), ('csam'), ('minor'), ('poi')) reviews(review)
    CROSS JOIN (VALUES (TRUE), (FALSE)) locks(locked)
    CROSS JOIN (VALUES (NULL::jsonb), ('{"nsfwLevelReason": "Knights Vote"}'::jsonb)) metas(metadata)
    CROSS JOIN (VALUES (NULL::jsonb), ('{"error": {"failureClass": "permanent"}}'::jsonb),
      ('{"lastFailure": {"failureClass": "permanent"}}'::jsonb), ('{"permanentFailure": true}'::jsonb),
      ('{"error": {"failureClass": "transient"}}'::jsonb)) scans(scan)
    CROSS JOIN (VALUES (TRUE), (FALSE)) restricts(restricted)
    CROSS JOIN (VALUES (NULL), ('tos')) blocks(blocked);
  `);
});
afterAll(() => pg.close());

describe('the shared profile-picture SQL text', () => {
  it('admits exactly the pictures servableProfilePictureSql admits with no block marker', async () => {
    const expected = await ids(
      Prisma.sql`SELECT i.id FROM "Image" i WHERE ${servableProfilePictureSql} AND NOT ${hasBlockMarkerSql(
        'i'
      )} ORDER BY i.id`
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(await idsText(servablePictureText, servablePictureParameters)).toEqual(expected);
  });

  it('finds a block marker exactly where hasBlockMarkerSql does', async () => {
    const expected = await ids(
      Prisma.sql`SELECT i.id FROM "Image" i WHERE ${hasBlockMarkerSql('i')} ORDER BY i.id`
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(await idsText(blockMarkerText('i'), [])).toEqual(expected);
  });

  it("uses the main app's constants", () => {
    expect(NSFW_BROWSING_LEVELS_FLAG).toBe(nsfwBrowsingLevelsFlag);
    expect(PERMANENT_SCAN_FAILURE).toBe(ImageScanFailureClass.Permanent);
  });
});
