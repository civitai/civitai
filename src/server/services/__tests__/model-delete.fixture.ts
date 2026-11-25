import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A Postgres stand-in for model deletes: `OWNER` owns model `owner * 10`, its versions
 * `owner * 100 + 1..3` and, on each version, file `version * 10 + 1`, plus one EntityAccess and one
 * PaidAccess row per version.
 */
export const OWNER = 1;
export const OTHER = 2;

export const modelOf = (owner: number) => owner * 10;
export const versionOf = (owner: number, n = 1) => owner * 100 + n;
export const fileOf = (version: number) => version * 10 + 1;

const SCHEMA = `
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "ModelVersion" (
    id int PRIMARY KEY,
    "modelId" int NOT NULL REFERENCES "Model"(id) ON DELETE CASCADE,
    name text NOT NULL DEFAULT 'v',
    status text NOT NULL DEFAULT 'Published',
    "trainingStatus" text,
    "baseModel" text NOT NULL DEFAULT 'SDXL 1.0',
    "publishedAt" timestamp,
    "initialPublishedAt" timestamp
  );
  CREATE TABLE "ModelFile" (
    id int PRIMARY KEY,
    "modelVersionId" int NOT NULL REFERENCES "ModelVersion"(id) ON DELETE CASCADE,
    url text NOT NULL,
    type text NOT NULL DEFAULT 'Model'
  );
  CREATE TABLE "ResourceReview" (
    id int PRIMARY KEY, "userId" int NOT NULL, "modelId" int,
    "modelVersionId" int NOT NULL REFERENCES "ModelVersion"(id) ON DELETE CASCADE,
    rating int NOT NULL DEFAULT 5, recommended boolean NOT NULL DEFAULT true, details text,
    exclude boolean NOT NULL DEFAULT false, nsfw boolean NOT NULL DEFAULT false,
    "tosViolation" boolean NOT NULL DEFAULT false, metadata jsonb,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL DEFAULT now()
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

export async function createModelDb() {
  const db = new PGlite();
  await db.exec(SCHEMA);
  return db;
}

/** Restores the owners' content, with nothing failing. */
export async function seedModelDb(db: PGlite) {
  await db.exec(`
    DROP TRIGGER IF EXISTS fail_delete ON "ModelVersion";
    DROP TRIGGER IF EXISTS fail_delete ON "ModelFile";
    TRUNCATE "Model", "EntityAccess", "PaidAccess", "Thread" CASCADE;
    INSERT INTO "Model" SELECT o * 10, o FROM unnest(ARRAY[${OWNER}, ${OTHER}]) o;
    INSERT INTO "ModelVersion" (id, "modelId")
      SELECT o * 100 + n, o * 10 FROM unnest(ARRAY[${OWNER}, ${OTHER}]) o, generate_series(1, 3) n;
    INSERT INTO "ModelFile" (id, "modelVersionId", url)
      SELECT id * 10 + 1, id, 'https://files.example.invalid/' || id FROM "ModelVersion";
    INSERT INTO "EntityAccess" SELECT id, 'ModelVersion' FROM "ModelVersion";
    INSERT INTO "PaidAccess" SELECT 'ModelVersion', id FROM "ModelVersion";
  `);
}

/** Makes every delete from `table` fail as a deadlock would. */
export const failDeletesFrom = (db: PGlite, table: 'ModelVersion' | 'ModelFile') =>
  db.exec(`
    CREATE OR REPLACE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$;
    CREATE TRIGGER fail_delete BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION fail_delete();
  `);

export const versionIds = async (db: PGlite) =>
  (await db.query<{ id: number }>(`SELECT id FROM "ModelVersion" ORDER BY id`)).rows.map(
    (r) => r.id
  );
export const fileIds = async (db: PGlite) =>
  (await db.query<{ id: number }>(`SELECT id FROM "ModelFile" ORDER BY id`)).rows.map((r) => r.id);

// The statements that decide what is deleted, run as written. Anything else the services issue
// touches tables this stand-in does not have, and gets the db mock's empty answer.
const ON_DB = /DELETE FROM "(Model(Version|File)|ResourceReview)"|FOR UPDATE/;

const toSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

/**
 * Sends `dbWrite`'s deciding raw statements to `db`. `before` runs ahead of each, with its text, so a
 * case can change the database between two.
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
}

/** A review of `versionId` by `reviewer`, with a thread on it that `commenter` commented in. */
export const seedReviewThread = (
  db: PGlite,
  { reviewId, versionId, reviewer, commenter }: Record<string, number>
) =>
  db.exec(`
    INSERT INTO "ResourceReview" (id, "userId", "modelVersionId") VALUES (${reviewId}, ${reviewer}, ${versionId});
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
