import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * A Postgres stand-in for the model content a hold keeps: three owners, one not held, one named on
 * a pending report, one under a hold marker. Each owns model `owner * 10`, its versions
 * `owner * 100 + 1..3` and, on each version, file `version * 10 + 1`.
 */
export const CLEAN = 1;
export const REPORTED = 2;
export const MARKED = 3;
export const OWNERS = [CLEAN, REPORTED, MARKED];

export const modelOf = (owner: number) => owner * 10;
export const versionOf = (owner: number, n = 1) => owner * 100 + n;
export const fileOf = (version: number) => version * 10 + 1;

export async function createModelHoldDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "needsReview" text,
      "blockedFor" text
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
  `);
  return db;
}

/** Restores every owner's content and holds, with the marker view in place. */
export async function seedModelHoldDb(db: PGlite) {
  await db.exec(`
    DROP VIEW IF EXISTS "EvidenceHeldUser";
    DROP TABLE IF EXISTS "EvidenceHold";
    DROP TRIGGER IF EXISTS fail_delete ON "ModelVersion";
    DROP TRIGGER IF EXISTS fail_delete ON "ModelFile";
    TRUNCATE "CsamReport", "Image", "Model" CASCADE;
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL, "releasedAt" timestamp(3));
    CREATE VIEW "EvidenceHeldUser" AS
      SELECT "userId" FROM "EvidenceHold" WHERE "releasedAt" IS NULL GROUP BY "userId";
    INSERT INTO "EvidenceHold" VALUES (${MARKED}, NULL);
    INSERT INTO "CsamReport" ("userId") VALUES (${REPORTED});
    INSERT INTO "Model" SELECT o * 10, o FROM unnest(ARRAY[${OWNERS}]) o;
    INSERT INTO "ModelVersion" (id, "modelId")
      SELECT o * 100 + n, o * 10 FROM unnest(ARRAY[${OWNERS}]) o, generate_series(1, 3) n;
    INSERT INTO "ModelFile" (id, "modelVersionId", url)
      SELECT id * 10 + 1, id, 'https://files.example.invalid/' || id FROM "ModelVersion";
  `);
}

/** Makes every delete from `table` fail as a deadlock would: a database error that is not a hold. */
export const failDeletesFrom = (db: PGlite, table: 'ModelVersion' | 'ModelFile') =>
  db.exec(`
    CREATE OR REPLACE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'deadlock detected' USING ERRCODE = '40P01'; END $$;
    CREATE TRIGGER fail_delete BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION fail_delete();
  `);

/** Whether the hold lookup can be read: without the marker view, the hold predicate errors. */
export const dropMarkerView = (db: PGlite) => db.exec(`DROP VIEW "EvidenceHeldUser"`);

export const versionIds = async (db: PGlite) =>
  (await db.query<{ id: number }>(`SELECT id FROM "ModelVersion" ORDER BY id`)).rows.map(
    (r) => r.id
  );
export const fileIds = async (db: PGlite) =>
  (await db.query<{ id: number }>(`SELECT id FROM "ModelFile" ORDER BY id`)).rows.map((r) => r.id);

// The statements that decide what is deleted, run as written. Anything else the services issue
// touches tables this stand-in does not have, and gets the db mock's empty answer.
const ON_DB = /DELETE FROM "Model(Version|File)"|AS held\b|FOR UPDATE/;

const toSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

/**
 * Sends `dbWrite`'s raw statements, and the Prisma deletes the same paths made before the hold check,
 * to `db`. The transaction runs on `dbWrite` itself (the db mock's default), so this covers it too.
 */
export function routeToDb(db: PGlite) {
  const w = dbMock.dbWrite;
  vi.mocked(w.$queryRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = toSql(first, values);
    if (!ON_DB.test(sql.text)) return [];
    return (await db.query(sql.text, sql.values)).rows;
  }) as never);
  vi.mocked(w.$executeRaw).mockImplementation((async (
    first: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = toSql(first, values);
    if (!ON_DB.test(sql.text)) return 0;
    return (await db.query(sql.text, sql.values)).affectedRows ?? 0;
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
