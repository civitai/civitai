import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A Postgres stand-in for the model content a hold keeps: three owners, one not held, one named on
 * a pending report, one under a hold marker. Each owns model `owner * 10`, its versions
 * `owner * 100 + 1..3` and, on each version, file `version * 10 + 1`, plus one EntityAccess and one
 * PaidAccess row per version. The hold marker's table and view come from their migration.
 */
export const CLEAN = 1;
export const REPORTED = 2;
export const MARKED = 3;
export const OWNERS = [CLEAN, REPORTED, MARKED];

export const modelOf = (owner: number) => owner * 10;
export const versionOf = (owner: number, n = 1) => owner * 100 + n;
export const fileOf = (version: number) => version * 10 + 1;

const OWNERSHIP_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261209120000_model_ownership/migration.sql'
);
const HOLD_MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
);

// What the migration's triggers attach to, as far as these cases need, and the model tables.
const BASE_SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    url text NOT NULL DEFAULT 'u',
    "postId" int,
    "nsfwLevel" int NOT NULL DEFAULT 0,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
    "needsReview" text,
    "blockedFor" text,
    metadata jsonb,
    "updatedAt" timestamp(3),
    "cascadeParentId" int
  );
  CREATE TABLE "Post" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    title text,
    detail text,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    "publishedAt" timestamp(3),
    "modelVersionId" int,
    "collectionId" int,
    metadata jsonb
  );
  CREATE TABLE "CsamReport" (
    id serial PRIMARY KEY,
    "userId" int,
    "reportSentAt" timestamp(3),
    "archivedAt" timestamp(3),
    images jsonb NOT NULL DEFAULT '[]',
    details jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "AppealDecisionRecord" (
    "imageId" int NOT NULL,
    "imageUrl" text,
    "blockedFor" text,
    decision text NOT NULL,
    "decidedAt" timestamptz NOT NULL DEFAULT now(),
    "removalLabel" text,
    "removalNsfw" text,
    "aiNsfwLevel" int,
    "trainingCopyState" text
  );
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "ModelVersion" (
    id int PRIMARY KEY,
    "modelId" int NOT NULL REFERENCES "Model"(id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT 'v',
    status text NOT NULL DEFAULT 'Published',
    "trainingStatus" text
  );
  CREATE TABLE "ModelFile" (
    id int PRIMARY KEY,
    "modelVersionId" int NOT NULL REFERENCES "ModelVersion"(id) ON DELETE CASCADE,
    url text NOT NULL,
    type text NOT NULL DEFAULT 'Model'
  );
  CREATE TABLE "ResourceReview" (
    id int PRIMARY KEY, "userId" int NOT NULL,
    "modelVersionId" int NOT NULL REFERENCES "ModelVersion"(id) ON DELETE CASCADE
  );
  CREATE TABLE "Thread" (
    id int PRIMARY KEY, "reviewId" int UNIQUE REFERENCES "ResourceReview"(id) ON DELETE CASCADE,
    "parentThreadId" int, "rootThreadId" int, "commentId" int, metadata jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "CommentV2" (
    id int PRIMARY KEY, "userId" int NOT NULL,
    "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE
  );
  -- Polymorphic, so no foreign key: the services remove these themselves.
  CREATE TABLE "EntityAccess" ("accessToId" int NOT NULL, "accessToType" text NOT NULL);
  CREATE TABLE "PaidAccess" ("entityType" text NOT NULL, "entityId" int NOT NULL);
`;

export async function createModelHoldDb() {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(readFileSync(HOLD_MIGRATION, 'utf8'));
  await db.exec(readFileSync(OWNERSHIP_MIGRATION, 'utf8'));
  return db;
}

/** Restores every owner's content and holds, with the marker view in place and nothing failing. */
export async function seedModelHoldDb(db: PGlite) {
  await db.exec(`
    ALTER VIEW IF EXISTS "EvidenceHeldUser_hidden" RENAME TO "EvidenceHeldUser";
    DROP TRIGGER IF EXISTS fail_delete ON "ModelVersion";
    DROP TRIGGER IF EXISTS fail_delete ON "ModelFile";
    -- The hold tables refuse TRUNCATE, so the reset runs with triggers off.
    SET session_replication_role = replica;
    TRUNCATE "CsamReport", "Image", "Model", "EntityAccess", "PaidAccess", "EvidenceHold",
      "EvidenceHoldImage", "EvidenceHoldPost", "Thread", "ModelOwnership" CASCADE;
    SET session_replication_role = DEFAULT;
    INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${MARKED}, 'manual', 'review');
    INSERT INTO "CsamReport" ("userId") VALUES (${REPORTED});
    INSERT INTO "Model" SELECT o * 10, o FROM unnest(ARRAY[${OWNERS}]) o;
    INSERT INTO "ModelVersion" (id, "modelId")
      SELECT o * 100 + n, o * 10 FROM unnest(ARRAY[${OWNERS}]) o, generate_series(1, 3) n;
    INSERT INTO "ModelFile" (id, "modelVersionId", url)
      SELECT id * 10 + 1, id, 'https://files.example.invalid/' || id FROM "ModelVersion";
    INSERT INTO "EntityAccess" SELECT id, 'ModelVersion' FROM "ModelVersion";
    INSERT INTO "PaidAccess" SELECT 'ModelVersion', id FROM "ModelVersion";
  `);
}

/** Puts `owner` on a pending report: a hold that lands after whatever read came before. */
export const holdOwner = (db: PGlite, owner: number) =>
  db.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [owner]);

/** Makes every delete from `table` fail as a deadlock would: a database error that is not a hold. */
export const failDeletesFrom = (db: PGlite, table: 'ModelVersion' | 'ModelFile') =>
  db.exec(`
    CREATE OR REPLACE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$;
    CREATE TRIGGER fail_delete BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION fail_delete();
  `);

/** Takes the marker view away, so the hold predicate errors as it would on a database without it. */
export const dropMarkerView = (db: PGlite) =>
  db.exec(`ALTER VIEW "EvidenceHeldUser" RENAME TO "EvidenceHeldUser_hidden"`);

export const versionIds = async (db: PGlite) =>
  (await db.query<{ id: number }>(`SELECT id FROM "ModelVersion" ORDER BY id`)).rows.map(
    (r) => r.id
  );
export const fileIds = async (db: PGlite) =>
  (await db.query<{ id: number }>(`SELECT id FROM "ModelFile" ORDER BY id`)).rows.map((r) => r.id);
/** The version ids that still have an EntityAccess and a PaidAccess row. */
export const accessRowsOf = async (db: PGlite) =>
  (
    await db.query<{ id: number }>(
      `SELECT ea."accessToId" AS id FROM "EntityAccess" ea
       JOIN "PaidAccess" pa ON pa."entityId" = ea."accessToId" ORDER BY 1`
    )
  ).rows.map((r) => r.id);

// The statements that decide what is deleted, run as written. Anything else the services issue
// touches tables this stand-in does not have, and gets the db mock's empty answer.
const ON_DB =
  /DELETE FROM "(Model(Version|File)|ResourceReview)"|UPDATE "Thread"|AS held\b|FOR UPDATE/;

const toSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

/**
 * Sends `dbWrite`'s raw statements to `db`, and the Prisma deletes these paths made before they were
 * guarded, so the same cases can be run against main's services to see them fail. `before` runs ahead
 * of each raw statement sent there, with its text, so a case can change the database between two. The transaction runs on `dbWrite` itself (the db mock's default),
 * unless `realTransactions` makes it a real one.
 */
export function routeToDb(db: PGlite, before?: (sql: string) => Promise<unknown>) {
  const w = dbMock.dbWrite;
  const send = async (sql: Prisma.Sql) => {
    if (before) await before(sql.text);
    return db.query(sql.text, sql.values);
  };
  vi.mocked(w.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = toSql(first, values);
    return ON_DB.test(sql.text) ? (await send(sql)).rows : [];
  }) as never);
  vi.mocked(w.$executeRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = toSql(first, values);
    return ON_DB.test(sql.text) ? (await send(sql)).affectedRows ?? 0 : 0;
  }) as never);

  const run = async (text: string, params: unknown[]) =>
    (await db.query(text, params)).affectedRows ?? 0;
  vi.mocked(w.modelVersion.delete).mockImplementation((async (args: { where: { id: number } }) => {
    await run(`DELETE FROM "ModelVersion" WHERE id = $1`, [args.where.id]);
    return { id: args.where.id };
  }) as never);
  vi.mocked(w.modelVersion.deleteMany).mockImplementation((async (args: {
    where: { id: { in: number[] } };
  }) => ({
    count: await run(`DELETE FROM "ModelVersion" WHERE id = ANY($1::int[])`, [args.where.id.in]),
  })) as never);
  vi.mocked(w.modelFile.deleteMany).mockImplementation((async (args: {
    where: { id: number; url: string; modelVersion: { model?: { userId: number } } };
  }) => {
    const owner = args.where.modelVersion.model?.userId ?? null;
    return {
      count: await run(
        `DELETE FROM "ModelFile" mf USING "ModelVersion" mv, "Model" m
         WHERE mf.id = $1 AND mf.url = $2 AND mv.id = mf."modelVersionId" AND m.id = mv."modelId"
           AND ($3::int IS NULL OR m."userId" = $3)`,
        [args.where.id, args.where.url, owner]
      ),
    };
  }) as never);
}

/**
 * Runs `dbWrite.$transaction` as a real transaction on `db`, and the access-row deletes inside it as
 * SQL, so a refusal's rollback is observed rather than assumed.
 */
export function realTransactions(db: PGlite) {
  const w = dbMock.dbWrite;
  vi.mocked(w.$transaction).mockImplementation((async (fn: (tx: unknown) => unknown) => {
    await db.exec('BEGIN');
    try {
      const result = await fn(w);
      await db.exec('COMMIT');
      return result;
    } catch (e) {
      await db.exec('ROLLBACK');
      throw e;
    }
  }) as never);
  vi.mocked(w.entityAccess.deleteMany).mockImplementation((async (args: {
    where: { accessToId: number; accessToType: string };
  }) => ({
    count: (
      await db.query(`DELETE FROM "EntityAccess" WHERE "accessToId" = $1 AND "accessToType" = $2`, [
        args.where.accessToId,
        args.where.accessToType,
      ])
    ).affectedRows,
  })) as never);
  vi.mocked(w.paidAccess.deleteMany).mockImplementation((async (args: {
    where: { entityType: string; entityId: number };
  }) => ({
    count: (
      await db.query(`DELETE FROM "PaidAccess" WHERE "entityType" = $1 AND "entityId" = $2`, [
        args.where.entityType,
        args.where.entityId,
      ])
    ).affectedRows,
  })) as never);
}

/** A review of `versionId` by `reviewer`, with a thread on it that `commenter` commented in. */
export const seedReviewThread = (
  db: PGlite,
  { reviewId, versionId, reviewer, commenter }: Record<string, number>
) =>
  db.exec(`
    INSERT INTO "ResourceReview" VALUES (${reviewId}, ${reviewer}, ${versionId});
    INSERT INTO "Thread" (id, "reviewId") VALUES (${reviewId}, ${reviewId});
    INSERT INTO "CommentV2" VALUES (${reviewId}, ${commenter}, ${reviewId});
  `);

/** Each remaining comment with whether its thread still hangs off a review. */
export const commentsLeft = async (db: PGlite) =>
  (
    await db.query<{ id: number; onReview: boolean }>(
      `SELECT c.id, t."reviewId" IS NOT NULL AS "onReview"
       FROM "CommentV2" c JOIN "Thread" t ON t.id = c."threadId" ORDER BY c.id`
    )
  ).rows;

/** An account that owns nothing here and no hold covers: an unheld earlier owner. */
export const FORMER_CLEAN = 4;

/** Records that `owner`'s model was created by `former` and transferred to `owner`. */
export const ownedBefore = (db: PGlite, owner: number, former: number) =>
  db.query(
    `INSERT INTO "ModelOwnership" ("modelId", "userId", reason) VALUES ($1, $2, 'create'), ($1, $3, 'transfer')`,
    [modelOf(owner), former, owner]
  );
