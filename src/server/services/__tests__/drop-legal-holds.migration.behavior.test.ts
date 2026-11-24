import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';

/**
 * The two drop-legal-holds migrations (triggers, then tables) run whole, twice, over the hold objects
 * as either live state left them, against a Postgres stand-in.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) =>
  readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');
const TRIGGERS = '20271127130000_drop_legal_hold_triggers';
const TABLES = '20271127130100_drop_legal_hold_tables';
const dropAll = async (pg: PGlite) => {
  await pg.exec(migration(TRIGGERS));
  await pg.exec(migration(TABLES));
};

const CAPTURE = FEEDBACK_CAPTURE_OWNER_ID;
const OTHER = 7;

const BASE_SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TYPE "CsamReportType" AS ENUM ('Image', 'TrainingData', 'GeneratedImage', 'ExternalLink');
  CREATE TABLE "Image" (
    id int PRIMARY KEY, "userId" int NOT NULL, url text NOT NULL DEFAULT 'u', "postId" int,
    "nsfwLevel" int NOT NULL DEFAULT 0, ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
    "needsReview" text, "blockedFor" text, minor boolean NOT NULL DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}', "updatedAt" timestamp(3), "cascadeParentId" int
  );
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "Post" (
    id int PRIMARY KEY, "userId" int NOT NULL, title text, detail text,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(), "publishedAt" timestamp(3),
    "modelVersionId" int, "collectionId" int, metadata jsonb
  );
  CREATE TABLE "CsamReport" (
    id serial PRIMARY KEY, "userId" int, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    "reportedById" int NOT NULL DEFAULT 1, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
    "contentRemovedAt" timestamp(3), "reportId" int, details jsonb NOT NULL DEFAULT '{}',
    images jsonb NOT NULL DEFAULT '[]', type "CsamReportType" NOT NULL DEFAULT 'Image'
  );
  CREATE TABLE "AppealDecisionRecord" (
    "imageId" int NOT NULL, "imageUrl" text, "blockedFor" text, decision text NOT NULL,
    "decidedAt" timestamptz NOT NULL DEFAULT now(), "removalLabel" text, "removalNsfw" text,
    "aiNsfwLevel" int, "trainingCopyState" text
  );
  CREATE TABLE "ResourceReview" (id int PRIMARY KEY);
  CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
  CREATE TYPE "JobQueueType" AS ENUM ('BlockedImageDelete', 'PendingDelete');
  CREATE TABLE "JobQueue" (
    "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
    data jsonb, "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    PRIMARY KEY ("entityType", "entityId", type)
  );
  CREATE FUNCTION create_job_queue_record(entityId INTEGER, entityType text, type text)
  RETURNS VOID AS $job$
  BEGIN
    INSERT INTO "JobQueue" ("entityId", "entityType", "type")
    VALUES (entityId, entityType::"EntityType", type::"JobQueueType")
    ON CONFLICT DO NOTHING;
  END;
  $job$ LANGUAGE plpgsql;
  CREATE TABLE "TextScanHold" (
    id serial PRIMARY KEY, "entityType" text, "entityId" int, label text, status text,
    "createdAt" timestamp(3) NOT NULL DEFAULT now()
  );
`;

// The hold migrations as they were applied, up to the two live trigger bodies: the owner-held one,
// or the feedback capture one (each refuses to apply over the other).
const SHARED = [
  '20261019220000_evidence_hold',
  '20261112120000_csam_report_append_only',
  '20261204120000_evidence_hold_image_prior_state',
  '20261209120000_model_ownership',
  '20261212120000_held_resource_review',
];
const LIVE_STATES = {
  'the owner-held trigger body': ['20261227150000_evidence_hold_owner_held'],
  'the feedback capture trigger body': [
    '20261231120100_feedback_capture_owner_hold',
    '20261231130100_feedback_capture_hold_lifetime',
  ],
};
const AFTER = ['20261231130000_feedback_capture_never_subject', '20270108093000_post_text'];

let db: PGlite | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

async function applyThrough(live: string[]) {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
  for (const name of [...SHARED, ...live, ...AFTER]) await db.exec(migration(name));
  return db;
}

const names = async (pg: PGlite, sql: string) =>
  (await pg.query<{ name: string }>(sql)).rows.map((r) => r.name).sort();

describe.each(Object.entries(LIVE_STATES))('over %s', (_, live) => {
  it('drops every hold object, keeps what stays, and runs again cleanly', async () => {
    const pg = await applyThrough(live);
    await dropAll(pg);
    await dropAll(pg);

    expect(
      await names(
        pg,
        `SELECT proname AS name FROM pg_proc
         WHERE proname LIKE 'evidence_hold%' OR proname = 'model_ownership_refuse_change'`
      )
    ).toEqual(['model_ownership_refuse_change']);
    expect(
      await names(
        pg,
        `SELECT relname AS name FROM pg_class
         WHERE relname IN ('EvidenceHold', 'EvidenceHoldImage', 'EvidenceHoldPost', 'EvidenceHeldUser',
           'HeldResourceReview', 'ModelOwnership')`
      )
    ).toEqual(['ModelOwnership']);
    expect(
      await names(
        pg,
        `SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%evidence_hold%'`
      )
    ).toEqual([]);
    expect(
      await names(
        pg,
        `SELECT proname AS name FROM pg_proc WHERE proname IN ('csam_report_guard_sent', 'post_text_held')`
      )
    ).toEqual(['csam_report_guard_sent', 'post_text_held']);
  });

  it('leaves image, post and model deletes and owner changes to go through', async () => {
    const pg = await applyThrough(live);
    await dropAll(pg);
    await pg.exec(`
      INSERT INTO "CsamReport" ("userId") VALUES (${OTHER});
      INSERT INTO "Image" (id, "userId", "needsReview") VALUES (1, ${OTHER}, 'csam');
      INSERT INTO "Post" (id, "userId") VALUES (1, ${OTHER});
      INSERT INTO "Model" (id, "userId") VALUES (1, ${OTHER});
      UPDATE "Model" SET "userId" = ${OTHER + 1} WHERE id = 1;
      DELETE FROM "Image" WHERE id = 1;
      DELETE FROM "Post" WHERE id = 1;
    `);

    const left = await pg.query(
      `SELECT (SELECT count(*) FROM "Image")::int AS images, (SELECT count(*) FROM "Post")::int AS posts`
    );
    expect(left.rows).toEqual([{ images: 0, posts: 0 }]);
  });

  it('queues each blocked image the hold kept for the blocked-image purge', async () => {
    const pg = await applyThrough(live);
    await pg.exec(`
      INSERT INTO "Image" (id, "userId", ingestion, "blockedFor") VALUES
        (1, ${OTHER}, 'Blocked', 'moderated'), (2, ${OTHER}, 'Scanned', NULL),
        (3, ${OTHER}, 'Blocked', 'AiNotVerified'), (4, ${OTHER}, 'Blocked', 'moderated');
      INSERT INTO "EvidenceHoldImage" ("imageId", "userId") VALUES (1, ${OTHER}), (2, ${OTHER}), (3, ${OTHER});
    `);

    await pg.exec(migration(TRIGGERS));
    const queue = async () =>
      (await pg.query(`SELECT "entityId", type FROM "JobQueue" ORDER BY 1`)).rows;
    // Not at deploy: the purge waits for part 2, so nothing a pending capture reads goes first.
    expect(await queue()).toEqual([]);

    await pg.exec(migration(TABLES));
    expect(await queue()).toEqual([{ entityId: 1, type: 'BlockedImageDelete' }]);
  });

  it('after the triggers part alone, lets deletes and owner changes through and keeps the hold relations', async () => {
    const pg = await applyThrough(live);
    await pg.exec(migration(TRIGGERS));
    await pg.exec(migration(TRIGGERS));
    await pg.exec(`
      INSERT INTO "CsamReport" ("userId") VALUES (${OTHER});
      INSERT INTO "Image" (id, "userId", "needsReview") VALUES (1, ${OTHER}, 'csam');
      INSERT INTO "Post" (id, "userId") VALUES (1, ${OTHER});
      INSERT INTO "Model" (id, "userId") VALUES (1, ${OTHER});
      UPDATE "Model" SET "userId" = ${OTHER + 1} WHERE id = 1;
      DELETE FROM "Image" WHERE id = 1;
      DELETE FROM "Post" WHERE id = 1;
    `);
    const left = await pg.query(
      `SELECT (SELECT count(*) FROM "Image")::int AS images, (SELECT count(*) FROM "Post")::int AS posts,
         (SELECT "userId" FROM "Model" WHERE id = 1) AS owner`
    );
    expect(left.rows).toEqual([{ images: 0, posts: 0, owner: OTHER + 1 }]);
    expect(
      await names(
        pg,
        `SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal
         AND tgrelid::regclass::text IN ('"Image"', '"Post"', '"Model"', '"CsamReport"')
         AND tgname LIKE '%evidence_hold%'`
      )
    ).toEqual([]);
    expect(
      await names(
        pg,
        `SELECT relname AS name FROM pg_class
         WHERE relname IN ('EvidenceHold', 'EvidenceHoldImage', 'EvidenceHoldPost', 'EvidenceHeldUser',
           'HeldResourceReview')`
      )
    ).toEqual(
      [
        'EvidenceHeldUser',
        'EvidenceHold',
        'EvidenceHoldImage',
        'EvidenceHoldPost',
        'HeldResourceReview',
      ].sort()
    );
    await pg.query('SELECT * FROM "EvidenceHeldUser" LIMIT 1');
  });

  // The capture account is still never a report subject: its constraint is not a hold's.
  it.each([
    ['a report subject', `INSERT INTO "CsamReport" ("userId") VALUES (${CAPTURE})`],
    [
      'a report’s secondary user',
      `INSERT INTO "CsamReport" ("userId", details) VALUES (${OTHER}, '{"secondaryUserId": ${CAPTURE}}')`,
    ],
    [
      'a report’s secondary user, as text',
      `INSERT INTO "CsamReport" ("userId", details) VALUES (${OTHER}, '{"secondaryUserId": "${CAPTURE}"}')`,
    ],
  ])('still refuses the capture account as %s', async (_label, sql) => {
    const pg = await applyThrough(live);
    await dropAll(pg);

    await expect(pg.exec(sql)).rejects.toThrow(/CsamReport_not_capture_owner_check/);
    await pg.exec(`INSERT INTO "CsamReport" ("userId", details) VALUES (NULL, '{}')`);
  });
});
