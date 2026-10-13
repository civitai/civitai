import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return holder.db.query(flat.text, flat.values as unknown[]);
};
dbMock.dbWrite.$executeRaw.mockImplementation(
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await run(strings, ...values)).affectedRows ?? 0) as never
);
dbMock.dbWrite.$queryRaw.mockImplementation(
  (async (strings: TemplateStringsArray, ...values: unknown[]) =>
    (await run(strings, ...values)).rows) as never
);

const { sweepExcludedRecords, fillRemovalLabels, recordRestoredLevels } = await import(
  '~/server/jobs/appeal-decision-records'
);

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261020120000_appeal_decision_record/migration.sql'
);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Model', 'Model3D');
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY,
      "userId" integer NOT NULL,
      "url" text NOT NULL,
      "pHash" bigint,
      "meta" jsonb,
      "metadata" jsonb,
      "ingestion" text NOT NULL DEFAULT 'Scanned',
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
    CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE training_labels (
      url text, label text, "createdAt" timestamp, source text, reason text, old_label text
    );
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  await holder.db.exec(
    `TRUNCATE "AppealDecisionRecord", "Image", "CsamReport", training_labels RESTART IDENTITY`
  );
});

type Rec = {
  appealId: number;
  imageId: number;
  ownerId?: number;
  decision?: 'Approved' | 'Rejected';
  removalLabel?: string | null;
  daysAgo?: number;
};
const record = ({
  appealId,
  imageId,
  ownerId = 7,
  decision = 'Approved',
  removalLabel = null,
  daysAgo = 1,
}: Rec) =>
  holder.db.query(
    `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "ownerId", "imageUrl", "nsfwLevel",
       "nsfwLevelLocked", "decision", "decidedAt", "removalLabel", "createdAt")
     VALUES ($1, $2, $3, $4, 32, true, $5, now() - make_interval(days => $6), $7,
       now() - make_interval(days => $6))`,
    [appealId, imageId, ownerId, `u-${imageId}`, decision, daysAgo, removalLabel]
  );
const image = (
  id: number,
  over: { nsfwLevel?: number; ingestion?: string; needsReview?: string; userId?: number } = {}
) =>
  holder.db.query(
    `INSERT INTO "Image" ("id", "userId", "url", "nsfwLevel", "ingestion", "needsReview") VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      over.userId ?? 7,
      `u-${id}`,
      over.nsfwLevel ?? 4,
      over.ingestion ?? 'Scanned',
      over.needsReview ?? null,
    ]
  );
const label = (imageId: number, value: string, minutesAgo: number) =>
  holder.db.query(
    `INSERT INTO training_labels (url, label, "createdAt", source) VALUES ($1, $2, now() - make_interval(mins => $3), 'knight')`,
    [`u-${imageId}`, value, minutesAgo]
  );
const recordIds = async () =>
  (
    await holder.db.query<{ appealId: number }>(
      `SELECT "appealId" FROM "AppealDecisionRecord" ORDER BY "appealId"`
    )
  ).rows.map((r) => r.appealId);
const rows = async () =>
  (
    await holder.db.query<{
      appealId: number;
      removalLabel: string | null;
      restoredLevel: number | null;
      corrected: boolean;
    }>(
      `SELECT "appealId", "removalLabel", "restoredLevel", ("trainingLabelCorrectedAt" IS NOT NULL) AS corrected
       FROM "AppealDecisionRecord" ORDER BY "appealId"`
    )
  ).rows;
const labels = async () =>
  (
    await holder.db.query(
      `SELECT url, label, source, old_label FROM training_labels WHERE source = 'appeal' ORDER BY url`
    )
  ).rows;

describe('sweepExcludedRecords', () => {
  beforeEach(async () => {
    await record({ appealId: 1, imageId: 101, ownerId: 7 });
    await record({ appealId: 2, imageId: 102, ownerId: 8 });
    await image(101, { userId: 7 });
    await image(102, { userId: 8 });
  });

  it('deletes a record whose image is later named in a CSAM report, and only that one', async () => {
    await holder.db.query(`INSERT INTO "CsamReport" ("images") VALUES ($1)`, [
      JSON.stringify([{ id: 101 }]),
    ]);

    expect(await sweepExcludedRecords()).toBe(1);
    expect(await recordIds()).toEqual([2]);
  });

  it('deletes every record of an owner later named in a CSAM report', async () => {
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (8)`);

    expect(await sweepExcludedRecords()).toBe(1);
    expect(await recordIds()).toEqual([1]);
  });

  it('deletes a record whose image is later CSAM-flagged', async () => {
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 102`);

    expect(await sweepExcludedRecords()).toBe(1);
    expect(await recordIds()).toEqual([1]);
  });

  it('keeps everything when nothing is excluded', async () => {
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 102`);

    expect(await sweepExcludedRecords()).toBe(0);
    expect(await recordIds()).toEqual([1, 2]);
  });
});

describe('fillRemovalLabels', () => {
  it('fills only missing labels, from the lookup, inside the window', async () => {
    await record({ appealId: 1, imageId: 101 });
    // An earlier appeal on the same image, already labelled: its label is not overwritten.
    await record({ appealId: 2, imageId: 101, removalLabel: 'kept' });
    await record({ appealId: 3, imageId: 103 });
    await record({ appealId: 4, imageId: 104, daysAgo: 45 });
    const lookup = vi.fn(
      async (ids: number[]) =>
        new Map(ids.filter((id) => id !== 103).map((id) => [id, `label-${id}`]))
    );

    expect(await fillRemovalLabels(lookup)).toBe(1);

    expect(lookup).toHaveBeenCalledWith([101, 103]);
    expect((await rows()).map((r) => [r.appealId, r.removalLabel])).toEqual([
      [1, 'label-101'],
      [2, 'kept'],
      [3, null],
      [4, null],
    ]);
  });

  it('skips the lookup when nothing is missing', async () => {
    const lookup = vi.fn(async () => new Map<number, string>());

    expect(await fillRemovalLabels(lookup)).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('recordRestoredLevels', () => {
  it('records the restored level and corrects a Blocked training label', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 4 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: 4, corrected: true },
    ]);
    expect(await labels()).toEqual([
      { url: 'u-101', label: 'R', source: 'appeal', old_label: 'Blocked' },
    ]);
  });

  it('leaves the training labels alone when the latest one is not Blocked', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 2 });
    await label(101, 'Blocked', 20);
    await label(101, 'PG13', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: 2, corrected: false },
    ]);
    expect(await labels()).toEqual([]);
  });

  it('waits while the image is still at the Blocked level', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 32 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: null, corrected: false },
    ]);
    expect(await labels()).toEqual([]);
  });

  it('does nothing for a rejection', async () => {
    await record({ appealId: 1, imageId: 101, decision: 'Rejected' });
    await image(101, { nsfwLevel: 4 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: null, corrected: false },
    ]);
    expect(await labels()).toEqual([]);
  });

  it('corrects once across runs', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 8 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();
    await recordRestoredLevels();

    expect(await labels()).toEqual([
      { url: 'u-101', label: 'X', source: 'appeal', old_label: 'Blocked' },
    ]);
  });
});
