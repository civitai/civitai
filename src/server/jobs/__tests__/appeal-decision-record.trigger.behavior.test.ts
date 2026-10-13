import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Booting PGlite (WASM Postgres) can exceed the default hook timeout on a contended runner.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * What the `appeal_decision_record` trigger writes, executed on an in-process Postgres running the
 * committed migration unmodified. Each case that expects no row has a twin that differs in one property
 * and does write one, so a zero cannot come from a trigger that writes nothing at all.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261020120000_appeal_decision_record/migration.sql'
);

const db = { pg: null as unknown as PGlite };

const OWNER = 11;
const APPELLANT = 12; // differs from the owner, so the owner exclusion is seen to key on the owner
const IMAGE = 501;
const DECIDED_AT = '2026-01-02T03:04:05.000Z';

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
    [APPELLANT, IMAGE]
  );
});

const records = async () =>
  (
    await db.pg.query<Record<string, unknown>>(
      `SELECT "appealId", "imageId", "imageUrl", "pHash"::text AS "pHash", "promptHash",
              "nsfwLevel", "nsfwLevelLocked", "nsfwLevelReason", "aiNsfwLevel", "blockedFor",
              "decision", "resolvedReason", to_char("decidedAt" AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "decidedAt"
       FROM "AppealDecisionRecord" ORDER BY id`
    )
  ).rows;

const decide = (status: string, reason: string | null = 'misclassified') =>
  db.pg.query(
    `UPDATE "Appeal" SET "status" = $1::"AppealStatus", "resolvedReason" = $2, "resolvedAt" = $3
     WHERE "status" = 'Pending'`,
    [status, reason, DECIDED_AT]
  );

describe('a decided image appeal', () => {
  it('writes the image as it was at decision time', async () => {
    // A non-UTC session, so a decision time read in the session's zone would be off by hours.
    await db.pg.exec(`SET TIME ZONE 'America/New_York'`);
    try {
      await decide('Approved');
    } finally {
      await db.pg.exec(`RESET TIME ZONE`);
    }

    expect(await records()).toEqual([
      {
        appealId: 1,
        imageId: IMAGE,
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
        decidedAt: DECIDED_AT,
      },
    ]);
  });

  it('records a rejection', async () => {
    await decide('Rejected', 'violation-confirmed');

    expect((await records()).map((r) => [r.decision, r.resolvedReason])).toEqual([
      ['Rejected', 'violation-confirmed'],
    ]);
  });

  it('falls back to now() when the decision carries no resolvedAt', async () => {
    await db.pg.exec(`UPDATE "Appeal" SET "status" = 'Approved'`);

    const [{ fresh }] = (
      await db.pg.query<{ fresh: boolean }>(
        `SELECT "decidedAt" > now() - interval '1 minute' AS fresh FROM "AppealDecisionRecord"`
      )
    ).rows;
    expect(fresh).toBe(true);
  });

  it('writes nothing for a void', async () => {
    await decide('Void', null);

    expect(await records()).toEqual([]);
  });

  it('writes nothing when a voided appeal is later marked decided', async () => {
    await decide('Void', null);
    await db.pg.exec(`UPDATE "Appeal" SET "status" = 'Approved'`);

    expect(await records()).toEqual([]);
  });

  it('writes nothing for an appeal on something other than an image', async () => {
    await db.pg.exec(`UPDATE "Appeal" SET "entityType" = 'Model'`);
    await decide('Approved');

    expect(await records()).toEqual([]);
  });

  it('keeps the first decision when a decided appeal is changed again', async () => {
    await decide('Approved');
    await db.pg.exec(`UPDATE "Appeal" SET "status" = 'Rejected', "resolvedReason" = 'other'`);

    expect((await records()).map((r) => [r.decision, r.resolvedReason])).toEqual([
      ['Approved', 'misclassified'],
    ]);
  });

  it('writes nothing when the image no longer exists', async () => {
    await db.pg.exec(`DELETE FROM "Image"`);
    await decide('Rejected');

    expect(await records()).toEqual([]);
  });
});

describe('never blocks the decision', () => {
  it('records even when the deciding role has no grant on the record table', async () => {
    await db.pg.exec(`
      DO $$ BEGIN CREATE ROLE appeal_writer; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT SELECT, UPDATE ON "Appeal" TO appeal_writer;
      GRANT SELECT ON "Image", "CsamReport" TO appeal_writer;
      SET ROLE appeal_writer;
    `);
    try {
      await decide('Rejected');
    } finally {
      await db.pg.exec(`RESET ROLE`);
    }

    expect(await records()).toHaveLength(1);
  });

  it('lets the decision through when the record cannot be written', async () => {
    await db.pg.exec(
      `ALTER TABLE "AppealDecisionRecord" ADD CONSTRAINT refuse_all CHECK (false) NOT VALID`
    );
    const notices: string[] = [];
    try {
      await db.pg.query(
        `UPDATE "Appeal" SET "status" = 'Approved', "resolvedAt" = $1 WHERE "status" = 'Pending'`,
        [DECIDED_AT],
        { onNotice: (n) => notices.push(n.message ?? '') }
      );
    } finally {
      await db.pg.exec(`ALTER TABLE "AppealDecisionRecord" DROP CONSTRAINT refuse_all`);
    }

    expect((await db.pg.query<{ status: string }>(`SELECT "status" FROM "Appeal"`)).rows).toEqual([
      { status: 'Approved' },
    ]);
    expect(await records()).toEqual([]);
    // The insert was attempted and its failure reported, not skipped.
    expect(notices).toEqual([
      expect.stringContaining('appeal_decision_record: appeal 1 not recorded'),
    ]);
  });
});

describe('exclusions', () => {
  // Flag first, then close, in one transaction.
  const flagAndClose = async (flag: string | null) => {
    await db.pg.transaction(async (tx) => {
      await tx.query(`UPDATE "Image" SET "needsReview" = $1 WHERE "id" = $2`, [flag, IMAGE]);
      await tx.query(
        `UPDATE "Appeal" SET "status" = 'Rejected', "resolvedAt" = now() WHERE "status" = 'Pending'`
      );
    });
  };

  it('writes nothing for an image flagged at close', async () => {
    await flagAndClose('csam');

    expect(await records()).toEqual([]);
  });

  it('control: the same close without that flag writes a row', async () => {
    await flagAndClose(null);

    expect(await records()).toHaveLength(1);
  });

  it('writes nothing for an image carrying the block marker', async () => {
    await db.pg.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM'`);
    await decide('Rejected');

    expect(await records()).toEqual([]);
  });

  it('control: another block reason writes a row', async () => {
    await db.pg.exec(`UPDATE "Image" SET "blockedFor" = 'tos'`);
    await decide('Rejected');

    expect(await records()).toHaveLength(1);
  });

  it('writes nothing for an image named in a report', async () => {
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

  it("writes nothing when the image's owner is named in a report", async () => {
    await db.pg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [OWNER]);
    await decide('Approved');

    expect(await records()).toEqual([]);
  });

  it('control: a report naming the appellant, not the owner, does not exclude', async () => {
    await db.pg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [APPELLANT]);
    await decide('Approved');

    expect(await records()).toHaveLength(1);
  });
});
