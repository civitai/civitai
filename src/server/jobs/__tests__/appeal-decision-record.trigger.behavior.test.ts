import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * What the `appeal_decision_record` trigger writes, executed on an in-process Postgres running the
 * committed migration unmodified. Each exclusion case has a twin that differs only in the excluded
 * property and does write a row, so a zero cannot come from a trigger that writes nothing at all.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261020120000_appeal_decision_record/migration.sql'
);

const db = { pg: null as unknown as PGlite };

const OWNER = 11;
const IMAGE = 501;

beforeAll(async () => {
  db.pg = await PGlite.create();
  await db.pg.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Model', 'Model3D');
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY,
      "userId" integer NOT NULL,
      "url" text NOT NULL,
      "pHash" bigint,
      "meta" jsonb,
      "metadata" jsonb,
      "nsfwLevel" integer NOT NULL DEFAULT 0,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "aiNsfwLevel" integer NOT NULL DEFAULT 0,
      "blockedFor" text,
      "needsReview" text
    );
    CREATE TABLE "Appeal" (
      "id" serial PRIMARY KEY,
      "userId" integer NOT NULL,
      "entityType" "EntityType" NOT NULL,
      "entityId" integer NOT NULL,
      "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
      "resolvedAt" timestamp(3),
      "resolvedReason" text
    );
    CREATE TABLE "CsamReport" (
      "id" serial PRIMARY KEY,
      "userId" integer,
      "images" jsonb NOT NULL DEFAULT '[]'
    );
  `);
  await db.pg.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await db.pg.close();
});

beforeEach(async () => {
  await db.pg.exec(`
    TRUNCATE "AppealDecisionRecord", "Appeal", "Image", "CsamReport" RESTART IDENTITY;
  `);
  await db.pg.query(
    `INSERT INTO "Image" ("id", "userId", "url", "pHash", "meta", "metadata", "nsfwLevel",
       "nsfwLevelLocked", "aiNsfwLevel", "blockedFor", "needsReview")
     VALUES ($1, $2, 'u-501', 77, '{"prompt": "a cat"}', '{"nsfwLevelReason": "Knights Vote"}', 32,
       true, 1, 'moderated', 'appeal')`,
    [IMAGE, OWNER]
  );
  await db.pg.query(
    `INSERT INTO "Appeal" ("userId", "entityType", "entityId") VALUES ($1, 'Image', $2)`,
    [OWNER, IMAGE]
  );
});

const records = async () =>
  (
    await db.pg.query<Record<string, unknown>>(
      `SELECT "appealId", "imageId", "ownerId", "imageUrl", "pHash"::text AS "pHash", "promptHash",
              "nsfwLevel", "nsfwLevelLocked", "nsfwLevelReason", "aiNsfwLevel", "blockedFor",
              "decision", "resolvedReason"
       FROM "AppealDecisionRecord" ORDER BY id`
    )
  ).rows;

const decide = (status: string, reason: string | null = 'misclassified') =>
  db.pg.query(
    `UPDATE "Appeal" SET "status" = $1::"AppealStatus", "resolvedReason" = $2, "resolvedAt" = now()
     WHERE "status" = 'Pending'`,
    [status, reason]
  );

describe('a decided image appeal', () => {
  it('writes the image as it was at decision time', async () => {
    await decide('Approved');

    expect(await records()).toEqual([
      {
        appealId: 1,
        imageId: IMAGE,
        ownerId: OWNER,
        imageUrl: 'u-501',
        pHash: '77',
        promptHash: (await db.pg.query<{ h: string }>(`SELECT md5('a cat') AS h`)).rows[0].h,
        nsfwLevel: 32,
        nsfwLevelLocked: true,
        nsfwLevelReason: 'Knights Vote',
        aiNsfwLevel: 1,
        blockedFor: 'moderated',
        decision: 'Approved',
        resolvedReason: 'misclassified',
      },
    ]);
  });

  it('records a rejection', async () => {
    await decide('Rejected', 'violation-confirmed');

    expect((await records()).map((r) => [r.decision, r.resolvedReason])).toEqual([
      ['Rejected', 'violation-confirmed'],
    ]);
  });

  it('writes nothing for a void', async () => {
    await decide('Void', null);

    expect(await records()).toEqual([]);
  });

  it('writes nothing for an appeal on something other than an image', async () => {
    await db.pg.exec(`UPDATE "Appeal" SET "entityType" = 'Model'`);
    await decide('Approved');

    expect(await records()).toEqual([]);
  });

  it('writes once: touching a decided appeal again adds nothing', async () => {
    await decide('Approved');
    await db.pg.exec(`UPDATE "Appeal" SET "status" = 'Approved', "resolvedReason" = 'other'`);

    expect(await records()).toHaveLength(1);
  });

  it('writes nothing when the image no longer exists', async () => {
    await db.pg.exec(`DELETE FROM "Image"`);
    await decide('Rejected');

    expect(await records()).toEqual([]);
  });
});

describe('CSAM exclusions', () => {
  // The CSAM report path sets the flag and closes the appeal in one transaction, flag first.
  const closeAsCsamReportDoes = async (flag: string | null) => {
    await db.pg.transaction(async (tx) => {
      await tx.query(`UPDATE "Image" SET "needsReview" = $1 WHERE "id" = $2`, [flag, IMAGE]);
      await tx.query(
        `UPDATE "Appeal" SET "status" = 'Rejected', "resolvedAt" = now() WHERE "status" = 'Pending'`
      );
    });
  };

  it('writes nothing when the image is CSAM-flagged at close', async () => {
    await closeAsCsamReportDoes('csam');

    expect(await records()).toEqual([]);
  });

  it('control: the same close with another flag writes a row', async () => {
    await closeAsCsamReportDoes('minor');

    expect(await records()).toHaveLength(1);
  });

  it('writes nothing when the image is in a CSAM report', async () => {
    await db.pg.query(`INSERT INTO "CsamReport" ("images") VALUES ($1)`, [
      JSON.stringify([{ id: 1 }, { id: IMAGE, hash: 'h' }]),
    ]);
    await decide('Rejected');

    expect(await records()).toEqual([]);
  });

  it('control: a report naming other images does not exclude this one', async () => {
    await db.pg.query(`INSERT INTO "CsamReport" ("images") VALUES ($1)`, [
      JSON.stringify([{ id: IMAGE + 1 }]),
    ]);
    await decide('Rejected');

    expect(await records()).toHaveLength(1);
  });

  it("writes nothing when the image's owner is named in a CSAM report", async () => {
    await db.pg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [OWNER]);
    await decide('Approved');

    expect(await records()).toEqual([]);
  });

  it('control: a report on another user does not exclude this owner', async () => {
    await db.pg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [OWNER + 1]);
    await decide('Approved');

    expect(await records()).toHaveLength(1);
  });
});
