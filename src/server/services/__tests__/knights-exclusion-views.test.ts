import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { CSAM_REPORT_LISTED_IMAGE_IDS_SQL, heldUserSql } from '@civitai/shared/held-media';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The Knights app's id-only views, loaded from their migration, against the helpers they stand in
 * for: each view must list exactly what its helper decides. The hold views come from the real
 * evidence-hold migration, so a hold's dates and release decide "EvidenceHeldUser" as they do live.
 *
 * Which fixture fails which mutation of a view:
 * - KnightsHeldUser
 *   - subject leg dropped: SUBJECT is missing.
 *   - its `IS NOT NULL` dropped: the report with no user adds a NULL row.
 *   - secondary leg dropped: SECONDARY (text) and SECONDARY_NUMBER (a JSON number) are missing.
 *   - its pattern filter dropped or loosened: the non-numeric and 21-digit secondary users reach the
 *     cast and reading the view throws, or (with the CASE kept) add a NULL row. Dropping only the
 *     CASE is not caught here: on tables this small the filter runs first. The CASE is for plans
 *     that cast before filtering, as in `heldUserSql`.
 *   - hold leg dropped: HOLD_OPEN and HOLD_EXTENDED are missing.
 *   - the hold leg reading "EvidenceHold" rather than the view: HOLD_RELEASED and HOLD_EXPIRED appear.
 * - KnightsCsamListedImage
 *   - scalar branch dropped: LISTED_NUMBER and LISTED_STRING are missing.
 *   - object branch dropped: LISTED_OBJECT and LISTED_OBJECT_STRING are missing.
 *   - array guard dropped: the reports whose images are an object or a string fail
 *     jsonb_array_elements, so reading the view throws.
 *   - `IS NOT NULL` dropped: the object with no id and the JSON null add NULL rows.
 * - KnightsOpenReportImage
 *   - Pending dropped: REPORT_PENDING is missing. Processing dropped: REPORT_PROCESSING is missing.
 *   - the status filter dropped: REPORT_ACTIONED and REPORT_UNACTIONED appear.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.join(__dirname, '../../../../packages/civitai-db-schema/prisma/migrations');
const readMigration = (name: string) =>
  readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf-8');
const VIEWS_MIGRATION = readMigration('20271125120000_knights_exclusion_views');
const HOLD_MIGRATION = readMigration('20261019220000_evidence_hold');

// Users, pairwise distinct and distinct from every image id below.
const SUBJECT = 101;
const SECONDARY = 102;
const SECONDARY_NUMBER = 103; // secondaryUserId stored as a JSON number
const NON_NUMERIC_PREFIX = 104; // secondaryUserId '104abc': not a user
const HOLD_OPEN = 105;
const HOLD_RELEASED = 106;
const HOLD_EXPIRED = 107;
const HOLD_EXTENDED = 108;
const CLEAN = 109;
const CANDIDATES = [
  SUBJECT,
  SECONDARY,
  SECONDARY_NUMBER,
  NON_NUMERIC_PREFIX,
  HOLD_OPEN,
  HOLD_RELEASED,
  HOLD_EXPIRED,
  HOLD_EXTENDED,
  CLEAN,
];

// Images listed on CsamReports.
const LISTED_NUMBER = 201;
const LISTED_STRING = 202;
const LISTED_OBJECT = 203;
const LISTED_OBJECT_STRING = 204;
const IN_NON_ARRAY_OBJECT = 205; // images is an object, not an array: not listed
const IN_NON_ARRAY_STRING = 206; // images is a string: not listed

// Images with reports.
const REPORT_PENDING = 301;
const REPORT_PROCESSING = 302;
const REPORT_ACTIONED = 303;
const REPORT_UNACTIONED = 304;

// The open-report leg of the Knights eligibility check, as the app runs it on the base tables.
const OPEN_REPORT_IMAGE_IDS_SQL = `SELECT ir."imageId" FROM "ImageReport" ir JOIN "Report" r ON r.id = ir."reportId"
  WHERE r.status IN ('Pending', 'Processing')`;

const VIEWS = {
  KnightsHeldUser: { column: 'userId', type: 'bigint' },
  KnightsCsamListedImage: { column: 'imageId', type: 'text' },
  KnightsOpenReportImage: { column: 'imageId', type: 'integer' },
} as const;

const pg = new PGlite();

beforeAll(async () => {
  await pg.exec(`
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "userId" INTEGER, "postId" INTEGER, "metadata" JSONB);
    CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
    CREATE TABLE "Model" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
    CREATE TABLE "CsamReport" (
      "id" SERIAL PRIMARY KEY, "userId" INTEGER, "reportSentAt" TIMESTAMP(3),
      "details" JSONB NOT NULL DEFAULT '{}', "images" JSONB NOT NULL DEFAULT '[]'
    );
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TABLE "Report" ("id" SERIAL PRIMARY KEY, "status" "ReportStatus" NOT NULL);
    CREATE TABLE "ImageReport" ("imageId" INTEGER NOT NULL, "reportId" INTEGER NOT NULL UNIQUE);
  `);
  await pg.exec(HOLD_MIGRATION);
  await pg.exec(VIEWS_MIGRATION);
  await pg.exec(`
    INSERT INTO "CsamReport" ("userId", "details", "images") VALUES
      (${SUBJECT}, '{}', '[${LISTED_NUMBER}, "${LISTED_STRING}"]'),
      (NULL, '{"secondaryUserId": "${SECONDARY}"}',
        '[{"id": ${LISTED_OBJECT}}, {"id": "${LISTED_OBJECT_STRING}"}, {"url": "no-id"}, null]'),
      (NULL, '{"secondaryUserId": ${SECONDARY_NUMBER}}', '{"id": ${IN_NON_ARRAY_OBJECT}}'),
      (NULL, '{"secondaryUserId": "${NON_NUMERIC_PREFIX}abc"}', '"${IN_NON_ARRAY_STRING}"'),
      (NULL, '{"secondaryUserId": "123456789012345678901"}', '[]'),
      (NULL, '{"secondaryUserId": null}', '[]'),
      (NULL, '{}', '[]');

    INSERT INTO "EvidenceHold" ("userId", "role", "reason", "releaseAt", "extendedUntil",
        "extensionRequestedBy", "extensionReference") VALUES
      (${HOLD_OPEN}, 'manual', 'held', NULL, NULL, NULL, NULL),
      (${HOLD_RELEASED}, 'manual', 'held', NULL, NULL, NULL, NULL),
      (${HOLD_EXPIRED}, 'manual', 'held', now() - interval '1 day', NULL, NULL, NULL),
      (${HOLD_EXTENDED}, 'manual', 'held', now() - interval '1 day', now() + interval '30 days',
        'requester', 'ref-1');
    UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = -1, "releaseReason" = 'test'
      WHERE "userId" = ${HOLD_RELEASED};

    INSERT INTO "Report" ("id", "status") VALUES
      (1, 'Pending'), (2, 'Processing'), (3, 'Actioned'), (4, 'Unactioned');
    INSERT INTO "ImageReport" ("imageId", "reportId") VALUES
      (${REPORT_PENDING}, 1), (${REPORT_PROCESSING}, 2), (${REPORT_ACTIONED}, 3), (${REPORT_UNACTIONED}, 4);
  `);
});

afterAll(async () => {
  await pg.close();
});

/** Every row of `sql`'s one column, as sorted text; a NULL stays null so it cannot hide. */
const column = async (sql: string) => {
  const { rows } = await pg.query<{ v: string | null }>(`SELECT v::text AS v FROM (${sql}) s(v)`);
  return rows.map((r) => r.v).sort((a, b) => String(a).localeCompare(String(b)));
};
const distinct = async (sql: string) => [...new Set(await column(sql))];
const ids = (...values: number[]) => values.map(String).sort();
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('Knights exclusion views', () => {
  it('KnightsHeldUser holds exactly the users heldUserSql holds', async () => {
    const helper = (
      await pg.query<{ id: number; held: boolean | null }>(
        `SELECT c.id, ${heldUserSql('c."id"')} AS held
         FROM unnest(ARRAY[${CANDIDATES.join(', ')}]::int[]) c(id) ORDER BY c.id`
      )
    ).rows
      .filter((r) => r.held)
      .map((r) => String(r.id));

    expect(helper).toEqual(ids(SUBJECT, SECONDARY, SECONDARY_NUMBER, HOLD_OPEN, HOLD_EXTENDED));
    // Every row, not only the candidates': a NULL or a stray id would show here.
    expect(await distinct('SELECT "userId" FROM "KnightsHeldUser"')).toEqual(helper);
  });

  it('KnightsCsamListedImage lists exactly what CSAM_REPORT_LISTED_IMAGE_IDS_SQL lists', async () => {
    const helper = await column(CSAM_REPORT_LISTED_IMAGE_IDS_SQL);
    expect(helper).toEqual(ids(LISTED_NUMBER, LISTED_STRING, LISTED_OBJECT, LISTED_OBJECT_STRING));
    expect(await column('SELECT "imageId" FROM "KnightsCsamListedImage"')).toEqual(helper);
    // The view is the helper's query as written, so a change to either shows here first.
    expect(normalize(VIEWS_MIGRATION)).toContain(normalize(CSAM_REPORT_LISTED_IMAGE_IDS_SQL));
  });

  it('KnightsOpenReportImage lists exactly the images with a Pending or Processing report', async () => {
    const base = await column(OPEN_REPORT_IMAGE_IDS_SQL);
    expect(base).toEqual(ids(REPORT_PENDING, REPORT_PROCESSING));
    expect(await column('SELECT "imageId" FROM "KnightsOpenReportImage"')).toEqual(base);
  });

  it('each view has exactly its one id column and is a security barrier', async () => {
    const { rows } = await pg.query<{
      view: string;
      kind: string;
      options: string[] | null;
      columns: string[];
    }>(
      `SELECT c.relname AS view, c.relkind::text AS kind, c.reloptions AS options,
         array_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum) AS columns
       FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE c.relname = ANY($1)
       GROUP BY c.relname, c.relkind, c.reloptions
       ORDER BY c.relname`,
      [Object.keys(VIEWS)]
    );
    expect(rows).toEqual(
      Object.entries(VIEWS)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([view, { column, type }]) => ({
          view,
          kind: 'v',
          options: ['security_barrier=true'],
          columns: [`${column} ${type}`],
        }))
    );
  });
});
