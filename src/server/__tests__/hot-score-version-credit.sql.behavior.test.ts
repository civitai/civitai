import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The Hot score triggers, run as written against an in-process Postgres: the migrations that
 * define them today, then any later hot-score migration, which is how the production database
 * receives them. Ids and counts are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(__dirname, '../../../packages/civitai-db-schema/prisma/migrations');
const BASELINE = [
  '20261011120000_model_hot_score_generator_cap',
  '20261012120000_base_model_metric_hot_score',
  '20261013120000_model_hot_score_generator_floor',
];
const LATER = readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_.*hot_score/.test(d) && d > BASELINE[BASELINE.length - 1])
  .sort();

const db = { pg: null as unknown as PGlite };

/** A CALL whose procedure COMMITs must run as its own statement, outside a transaction block. */
async function apply(dir: string) {
  const sql = readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
  let chunk: string[] = [];
  for (const line of sql.split('\n')) {
    if (/^CALL /.test(line)) {
      await db.pg.exec(chunk.join('\n'));
      await db.pg.exec(line);
      chunk = [];
    } else chunk.push(line);
  }
  await db.pg.exec(chunk.join('\n'));
}

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const MONTH = 2_592_000;

/** The pre-existing model term, in JS: lifetime counts plus the model's publish date. */
const modelTerm = (likes: number, published: Date) =>
  Math.round((Math.log10(1 + likes) + published.getTime() / 1000 / MONTH) * 10000);

type Version = {
  base?: string;
  at: Date;
  likes: number;
  downloads?: number;
  generations?: number;
  status?: string;
};

let nextModel = 1;
/** Writes versions first, as the metrics job does, then the ModelMetric row the trigger scores. */
async function model(
  published: Date,
  likes: number,
  versions: Version[],
  opts: { id?: number; uniqueGenerators?: number } = {}
) {
  const modelId = opts.id ?? nextModel++;
  for (const [i, v] of versions.entries()) {
    const id = modelId * 100 + i;
    await db.pg.query(
      `INSERT INTO "ModelVersion" (id, "modelId", "baseModel", status, "publishedAt") VALUES ($1, $2, $3, $4, $5)`,
      [id, modelId, v.base ?? 'SDXL 1.0', v.status ?? 'Published', v.at.toISOString()]
    );
    await db.pg.query(
      `INSERT INTO "ModelVersionMetric" ("modelVersionId", "thumbsUpCount", "downloadCount", "generationCount")
       VALUES ($1, $2, $3, $4)`,
      [id, v.likes, v.downloads ?? 0, v.generations ?? 0]
    );
  }
  await db.pg.query(
    `INSERT INTO "ModelMetric" ("modelId", "thumbsUpCount", "publishedAt", "uniqueGeneratorCount")
     VALUES ($1, $2, $3, $4)`,
    [modelId, likes, published.toISOString(), opts.uniqueGenerators ?? 0]
  );
  return modelId;
}

const score = async (modelId: number) =>
  (
    await db.pg.query<{ hotScore: number }>(
      `SELECT "hotScore" FROM "ModelMetric" WHERE "modelId" = $1`,
      [modelId]
    )
  ).rows[0].hotScore;

const slice = async (modelId: number, baseModel: string, likes: number) => {
  await db.pg.query(
    `INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "thumbsUpCount", "generationCount", "uniqueGeneratorCount")
     VALUES ($1, $2, $3, 0, 0)`,
    [modelId, baseModel, likes]
  );
  return (
    await db.pg.query<{ hotScore: number }>(
      `SELECT "hotScore" FROM "ModelBaseModelMetric" WHERE "modelId" = $1 AND "baseModel" = $2`,
      [modelId, baseModel]
    )
  ).rows[0].hotScore;
};

const OLD = daysAgo(540);
const RECENT = daysAgo(3);
const BATCH_EDGES = [250_000, 500_000];
let preexisting: number;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TABLE "ModelMetric" (
      "modelId" int PRIMARY KEY, "thumbsUpCount" int NOT NULL DEFAULT 0,
      "downloadCount" int NOT NULL DEFAULT 0, "generationCount" int NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "lastVersionAt" timestamp(3), "hotScore" int
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, "baseModel" text NOT NULL,
      status text NOT NULL, "publishedAt" timestamp(3)
    );
    CREATE TABLE "ModelVersionMetric" (
      "modelVersionId" int PRIMARY KEY, "thumbsUpCount" int NOT NULL DEFAULT 0,
      "downloadCount" int NOT NULL DEFAULT 0, "generationCount" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "ModelBaseModelMetric" (
      "modelId" int NOT NULL, "baseModel" text NOT NULL,
      "thumbsUpCount" int NOT NULL DEFAULT 0, "downloadCount" int NOT NULL DEFAULT 0,
      "hotScore" int, PRIMARY KEY ("modelId", "baseModel")
    );
  `);
  for (const dir of BASELINE) await apply(dir);

  // Scored by today's trigger, before the later migrations land: their backfill must reach it.
  preexisting = await model(OLD, 12_000, [
    { at: OLD, likes: 11_500 },
    { at: RECENT, likes: 500 },
  ]);
  await db.pg.query(
    `INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "thumbsUpCount") VALUES ($1, 'SDXL 1.0', 0)`,
    [preexisting]
  );
  // The backfill walks ids in fixed batches (its default size): one row opening each later
  // batch, the last at the max id, each with a mirrored slice and a measured one.
  for (const id of BATCH_EDGES) {
    await model(
      OLD,
      12_000,
      [
        { at: OLD, likes: 11_500 },
        { at: RECENT, likes: 500 },
      ],
      { id }
    );
    await db.pg.query(
      `INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "thumbsUpCount") VALUES ($1, 'Mirror', 0)`,
      [id]
    );
    await db.pg.query(
      `INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "thumbsUpCount", "generationCount", "uniqueGeneratorCount")
       VALUES ($1, 'SDXL 1.0', 12000, 0, 0)`,
      [id]
    );
  }

  for (const dir of LATER) await apply(dir);
});

afterAll(async () => {
  await db.pg?.close();
});

describe('Hot credits a model for a newer version, on that version alone', () => {
  it('ranks an old model with a used new version above the same model without one', async () => {
    const without = await model(OLD, 12_000, [{ at: OLD, likes: 12_000 }]);
    const withNew = await model(OLD, 12_000, [
      { at: OLD, likes: 11_500 },
      { at: RECENT, likes: 500 },
    ]);

    expect(await score(withNew)).toBeGreaterThan(await score(without));
  });

  it('caps the credit at a brand-new model with 100 engagement published the same day', async () => {
    const at = daysAgo(2);
    const viralVersion = await model(OLD, 50_000, [
      { at: OLD, likes: 40_000 },
      { at, likes: 10_000 },
    ]);
    // log10(1 + 99) = 2.0 exactly, the cap.
    const newModelAtCap = await model(at, 99, [{ at, likes: 99 }]);
    const newModelAboveCap = await model(at, 1_000, [{ at, likes: 1_000 }]);

    expect(await score(viralVersion)).toBe(await score(newModelAtCap));
    expect(await score(viralVersion)).toBeLessThan(await score(newModelAboveCap));
  });

  it("does not lend a version the model's lifetime engagement", async () => {
    const at = daysAgo(1);
    const emptyVersion = await model(OLD, 12_000, [
      { at: OLD, likes: 12_000 },
      { at, likes: 0 },
    ]);
    const emptyNewModel = await model(at, 0, [{ at, likes: 0 }]);

    expect(await score(emptyVersion)).toBe(await score(emptyNewModel));
  });

  it('leaves a single-version model on the model term', async () => {
    const id = await model(OLD, 12_000, [{ at: OLD, likes: 12_000 }]);

    expect(Math.abs((await score(id)) - modelTerm(12_000, OLD))).toBeLessThanOrEqual(1);
  });

  it('gives no credit for an unpublished version', async () => {
    const id = await model(OLD, 12_000, [
      { at: OLD, likes: 12_000 },
      { at: RECENT, likes: 500, status: 'Draft' },
    ]);

    expect(Math.abs((await score(id)) - modelTerm(12_000, OLD))).toBeLessThanOrEqual(1);
  });

  it('clamps a future-dated version to now', async () => {
    const id = await model(OLD, 12_000, [
      { at: OLD, likes: 12_000 },
      { at: new Date(Date.now() + 30 * DAY), likes: 99 },
    ]);
    const ceiling = Math.round((2 + Date.now() / 1000 / MONTH) * 10000);

    expect(await score(id)).toBeGreaterThan(modelTerm(12_000, OLD));
    expect(await score(id)).toBeLessThanOrEqual(ceiling);
  });

  it('backfills rows scored before the migration, and their mirrored slices', async () => {
    const twin = await model(OLD, 12_000, [
      { at: OLD, likes: 11_500 },
      { at: RECENT, likes: 500 },
    ]);
    const mirror = await db.pg.query<{ hotScore: number }>(
      `SELECT "hotScore" FROM "ModelBaseModelMetric" WHERE "modelId" = $1`,
      [preexisting]
    );

    expect(await score(preexisting)).toBeGreaterThan(modelTerm(12_000, OLD));
    expect(await score(preexisting)).toBe(await score(twin));
    expect(mirror.rows[0].hotScore).toBe(await score(preexisting));

    for (const id of BATCH_EDGES) {
      const slices = await db.pg.query<{ baseModel: string; hotScore: number }>(
        `SELECT "baseModel", "hotScore" FROM "ModelBaseModelMetric" WHERE "modelId" = $1`,
        [id]
      );
      const byBase = Object.fromEntries(slices.rows.map((r) => [r.baseModel, r.hotScore]));

      expect(await score(id)).toBe(await score(twin));
      expect(byBase['Mirror']).toBe(await score(twin));
      expect(byBase['SDXL 1.0']).toBeGreaterThan(modelTerm(12_000, OLD));
    }
  });

  it("scores a version's downloads, and its generations only past the first generator", async () => {
    const at = daysAgo(2);
    const atCap = await score(await model(at, 99, [{ at, likes: 99 }]));
    const empty = await score(await model(at, 0, [{ at, likes: 0 }]));
    const old = { at: OLD, likes: 12_000 };

    // Downloads count at 1/6.4 of a like, so this alone is past the cap.
    const downloads = await model(OLD, 12_000, [old, { at, likes: 0, downloads: 6_400 }]);
    const oneGenerator = await model(OLD, 12_000, [old, { at, likes: 0, generations: 5_000 }], {
      uniqueGenerators: 1,
    });
    const manyGenerators = await model(OLD, 12_000, [old, { at, likes: 0, generations: 5_000 }], {
      uniqueGenerators: 50,
    });

    expect(await score(downloads)).toBe(atCap);
    expect(await score(oneGenerator)).toBe(empty);
    expect(await score(manyGenerators)).toBe(atCap);
  });
});

describe('per-base-model Hot credits a slice only for its own versions', () => {
  it('lifts a slice whose own base model has a used new version', async () => {
    const id = await model(OLD, 2_500, [
      { at: OLD, likes: 2_000 },
      { at: RECENT, likes: 500 },
    ]);
    const plain = await model(OLD, 2_500, [{ at: OLD, likes: 2_500 }]);

    expect(await slice(id, 'SDXL 1.0', 2_500)).toBeGreaterThan(
      await slice(plain, 'SDXL 1.0', 2_500)
    );
  });

  it("ignores another base model's version", async () => {
    const id = await model(OLD, 2_500, [
      { at: OLD, likes: 2_000 },
      { at: RECENT, likes: 500, base: 'Flux.1 D' },
    ]);

    expect(
      Math.abs((await slice(id, 'SDXL 1.0', 2_000)) - modelTerm(2_000, OLD))
    ).toBeLessThanOrEqual(1);
  });
});
