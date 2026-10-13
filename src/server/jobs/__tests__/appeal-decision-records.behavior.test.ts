import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  ch: null as null | { $query: ReturnType<typeof vi.fn> },
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get clickhouse() {
    return holder.ch;
  },
}));

// PGlite infers parameter types where Prisma binds JS numbers as int8, so binding mistakes (the
// make_interval kind) are invisible here; the no-bound-make-interval guard covers those.
type Raw = ReturnType<typeof pgliteRaw>;
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);

const {
  sweepExcludedRecords,
  fillRemovalLabels,
  recordRestoredLevels,
  removalLabelsFromClickhouse,
  runAppealDecisionRecords,
} = await import('~/server/jobs/appeal-decision-records');

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
    -- Stand-in with the production columns; the table is not in the Prisma schema.
    CREATE TABLE training_labels (
      url text, label text, "createdAt" timestamp, source text, reason text, old_label text
    );
  `);
  await holder.db.exec(readFileSync(MIGRATION, 'utf8'));
});

beforeEach(async () => {
  holder.ch = null;
  await holder.db.exec(
    `TRUNCATE "AppealDecisionRecord", "Image", "CsamReport", training_labels RESTART IDENTITY`
  );
});

type Rec = {
  appealId: number;
  imageId: number;
  decision?: 'Approved' | 'Rejected';
  removalLabel?: string | null;
  blockedFor?: string | null;
  daysAgo?: number;
};
const record = ({
  appealId,
  imageId,
  decision = 'Approved',
  removalLabel = null,
  blockedFor = 'moderated',
  daysAgo = 1,
}: Rec) =>
  holder.db.query(
    `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel",
       "nsfwLevelLocked", "blockedFor", "decision", "decidedAt", "removalLabel", "createdAt")
     VALUES ($1, $2, $3, 32, true, $7, $4, now() - make_interval(days => $5), $6,
       now() - make_interval(days => $5))`,
    [appealId, imageId, `u-${imageId}`, decision, daysAgo, removalLabel, blockedFor]
  );
const image = (
  id: number,
  over: {
    nsfwLevel?: number;
    ingestion?: string;
    needsReview?: string;
    blockedFor?: string;
    userId?: number;
  } = {}
) =>
  holder.db.query(
    `INSERT INTO "Image" ("id", "userId", "url", "nsfwLevel", "ingestion", "needsReview", "blockedFor")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      over.userId ?? 7,
      `u-${id}`,
      over.nsfwLevel ?? 4,
      over.ingestion ?? 'Scanned',
      over.needsReview ?? null,
      over.blockedFor ?? null,
    ]
  );
const label = (imageId: number, value: string, minutesAgo: number, source = 'knight') =>
  holder.db.query(
    `INSERT INTO training_labels (url, label, "createdAt", source)
     VALUES ($1, $2, now() - make_interval(mins => $3), $4)`,
    [`u-${imageId}`, value, minutesAgo, source]
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
const appealLabels = async () =>
  (
    await holder.db.query(
      `SELECT url, label, source, old_label FROM training_labels WHERE source = 'appeal' ORDER BY url`
    )
  ).rows;
const allLabels = async () =>
  (await holder.db.query(`SELECT url, label, source FROM training_labels ORDER BY url, label`))
    .rows;

describe('sweepExcludedRecords', () => {
  beforeEach(async () => {
    await record({ appealId: 1, imageId: 101 });
    await record({ appealId: 2, imageId: 102 });
    await image(101, { userId: 7 });
    await image(102, { userId: 8 });
  });

  it('deletes a record whose image is later named in a report, and only that one', async () => {
    await holder.db.query(`INSERT INTO "CsamReport" ("images") VALUES ($1)`, [
      JSON.stringify([{ id: 101 }]),
    ]);

    expect(await sweepExcludedRecords()).toEqual({ swept: 1, expired: 0 });
    expect(await recordIds()).toEqual([2]);
  });

  it('deletes every record of an owner later named in a report', async () => {
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (8)`);

    expect((await sweepExcludedRecords()).swept).toBe(1);
    expect(await recordIds()).toEqual([1]);
  });

  it('deletes a record whose image is later flagged', async () => {
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 102`);

    expect((await sweepExcludedRecords()).swept).toBe(1);
    expect(await recordIds()).toEqual([1]);
  });

  it('deletes a record whose image later carries the block marker', async () => {
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = 102`);

    expect((await sweepExcludedRecords()).swept).toBe(1);
    expect(await recordIds()).toEqual([1]);
  });

  it('deletes a record that snapshotted the block marker, after its image is gone', async () => {
    await record({ appealId: 3, imageId: 103, blockedFor: 'CSAM' });

    expect((await sweepExcludedRecords()).swept).toBe(1);
    expect(await recordIds()).toEqual([1, 2]);
  });

  it('keeps everything when nothing is excluded', async () => {
    await holder.db.exec(
      `UPDATE "Image" SET "needsReview" = 'poi', "blockedFor" = 'tos' WHERE id = 102`
    );

    expect(await sweepExcludedRecords()).toEqual({ swept: 0, expired: 0 });
    expect(await recordIds()).toEqual([1, 2]);
  });

  it("removes the training labels this job wrote for a swept record, and nobody else's", async () => {
    await label(101, 'R', 5, 'appeal');
    await label(101, 'Blocked', 50, 'knight');
    await label(102, 'R', 5, 'appeal');
    await holder.db.query(`INSERT INTO "CsamReport" ("images") VALUES ($1)`, [
      JSON.stringify([{ id: 101 }]),
    ]);

    await sweepExcludedRecords();

    expect(await allLabels()).toEqual([
      { url: 'u-101', label: 'Blocked', source: 'knight' },
      { url: 'u-102', label: 'R', source: 'appeal' },
    ]);
  });

  it('deletes records past retention', async () => {
    await record({ appealId: 3, imageId: 103, daysAgo: 800 });

    expect(await sweepExcludedRecords()).toEqual({ swept: 0, expired: 1 });
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

describe('removalLabelsFromClickhouse', () => {
  it('asks for the latest DeleteTOS violation per image and maps the answer', async () => {
    const $query = vi.fn(async () => [{ imageId: 5, label: 'spam' }]);
    holder.ch = { $query };

    expect(await removalLabelsFromClickhouse([5, 6])).toEqual(new Map([[5, 'spam']]));

    const [strings, ...values] = $query.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const sql = strings.join('?');
    expect(sql).toContain("type = 'DeleteTOS'");
    expect(sql).toContain("argMax(coalesce(nullIf(violationType, ''), tosReason), time)");
    expect(values).toEqual([[5, 6]]);
  });

  it('answers empty without a client or without ids', async () => {
    expect(await removalLabelsFromClickhouse([5])).toEqual(new Map());
    const $query = vi.fn();
    holder.ch = { $query };
    expect(await removalLabelsFromClickhouse([])).toEqual(new Map());
    expect($query).not.toHaveBeenCalled();
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
    expect(await appealLabels()).toEqual([
      { url: 'u-101', label: 'R', source: 'appeal', old_label: 'Blocked' },
    ]);
  });

  it.each([
    [1, 'PG'],
    [16, 'XXX'],
  ])('labels level %i as %s', async (level, name) => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: level });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect((await appealLabels()).map((l) => l.label)).toEqual([name]);
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
    expect(await appealLabels()).toEqual([]);
  });

  it('records the level of an image that never had a training label', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 2 });

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: 2, corrected: false },
    ]);
  });

  it.each([
    ['still at the Blocked level', { nsfwLevel: 32 }, 1],
    ['unrated', { nsfwLevel: 0 }, 1],
    ['not scanned', { ingestion: 'Pending' }, 1],
    ['decided outside the window', {}, 100],
  ])('waits while the image is %s', async (_, over, daysAgo) => {
    await record({ appealId: 1, imageId: 101, daysAgo });
    await image(101, { nsfwLevel: 4, ...over });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: null, corrected: false },
    ]);
    expect(await appealLabels()).toEqual([]);
  });

  it('does nothing for a rejection', async () => {
    await record({ appealId: 1, imageId: 101, decision: 'Rejected' });
    await image(101, { nsfwLevel: 4 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: null, corrected: false },
    ]);
    expect(await appealLabels()).toEqual([]);
  });

  it('does nothing for an excluded record the sweep has not reached', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 4 });
    await label(101, 'Blocked', 10);
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (7)`);

    await recordRestoredLevels();

    expect(await appealLabels()).toEqual([]);
  });

  it('writes one label for two approvals of the same image', async () => {
    await record({ appealId: 1, imageId: 101 });
    await record({ appealId: 2, imageId: 101 });
    await image(101, { nsfwLevel: 8 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await appealLabels()).toEqual([
      { url: 'u-101', label: 'X', source: 'appeal', old_label: 'Blocked' },
    ]);
    expect((await rows()).map((r) => r.corrected)).toEqual([true, true]);
  });

  it('handles a record once, even if the image is labelled Blocked again later', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 8 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();
    await label(101, 'Blocked', 0);
    await recordRestoredLevels();

    expect(await appealLabels()).toEqual([
      { url: 'u-101', label: 'X', source: 'appeal', old_label: 'Blocked' },
    ]);
  });
});

describe('the nightly run', () => {
  it('sweeps before it labels or corrects anything', async () => {
    await record({ appealId: 1, imageId: 101 });
    await record({ appealId: 2, imageId: 102 });
    await image(101, { userId: 7, nsfwLevel: 4 });
    await image(102, { userId: 8, nsfwLevel: 4 });
    await label(101, 'Blocked', 10);
    await label(102, 'Blocked', 10);
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (8)`);
    const lookup = vi.fn(async (ids: number[]) => new Map(ids.map((id) => [id, 'spam'])));

    expect(await runAppealDecisionRecords(lookup)).toEqual({
      swept: 1,
      expired: 0,
      labelled: 1,
      restored: 1,
      corrected: 1,
    });
    expect(lookup).toHaveBeenCalledWith([101]);
    expect((await appealLabels()).map((l) => l.url)).toEqual(['u-101']);
  });
});
