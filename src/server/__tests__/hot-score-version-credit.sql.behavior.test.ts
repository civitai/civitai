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
async function apply(dir: string, file = 'migration.sql', pg = db.pg) {
  const sql = readFileSync(path.join(MIGRATIONS, dir, file), 'utf8');
  let chunk: string[] = [];
  for (const line of sql.split('\n')) {
    if (/^CALL /.test(line)) {
      await pg.exec(chunk.join('\n'));
      // Batches of 2, so the few candidates here still span more than one batch.
      const call = line.replace(
        'rescore_hot_version_head_start()',
        'rescore_hot_version_head_start(2)'
      );
      if (dir === HEAD_START_DIR && file === 'migration.sql' && call === line)
        throw new Error(`the batch-size override no longer matches the CALL line: ${line}`);
      await pg.exec(call);
      chunk = [];
    } else chunk.push(line);
  }
  await pg.exec(chunk.join('\n'));
}

const HEAD_START_DIR = '20271121120000_model_hot_score_version_head_start';

/**
 * Runs a file the way psql does WITHOUT ON_ERROR_STOP: one top-level statement at a time,
 * carrying on past errors. Splits on a line ending in ";" outside a dollar-quoted body.
 */
async function applyLikePsqlWithoutErrorStop(pg: PGlite, file: string) {
  const sql = readFileSync(path.join(MIGRATIONS, HEAD_START_DIR, file), 'utf8');
  const errors: string[] = [];
  let statement: string[] = [];
  let quote: string | null = null;
  for (const line of sql.split('\n')) {
    statement.push(line);
    for (const tag of line.match(/\$[a-z_]*\$/g) ?? []) quote = quote === tag ? null : quote ?? tag;
    if (quote === null && /;\s*$/.test(line) && !/^\s*--/.test(line)) {
      await pg.exec(statement.join('\n')).catch((e: Error) => errors.push(e.message));
      statement = [];
    }
  }
  return errors;
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
  /** Defaults to `at`, as a first publish sets it. */
  initial?: Date | null;
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
      `INSERT INTO "ModelVersion" (id, "modelId", "baseModel", status, "publishedAt", "initialPublishedAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        modelId,
        v.base ?? 'SDXL 1.0',
        v.status ?? 'Published',
        v.at.toISOString(),
        v.initial === undefined ? v.at.toISOString() : v.initial?.toISOString() ?? null,
      ]
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
// Qualifies on downloads alone, 45 days old: pins the rescore's candidate scan to the full bar and
// the full 60-day window, which every other backfill fixture (3 days, likes) would not notice.
let preexistingByDownloads: number;
const DAY_45 = daysAgo(45);

const SCHEMA = `
    CREATE TABLE "ModelMetric" (
      "modelId" int PRIMARY KEY, "thumbsUpCount" int NOT NULL DEFAULT 0,
      "downloadCount" int NOT NULL DEFAULT 0, "generationCount" int NOT NULL DEFAULT 0,
      "publishedAt" timestamp(3), "lastVersionAt" timestamp(3), "hotScore" int
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, "baseModel" text NOT NULL,
      status text NOT NULL, "publishedAt" timestamp(3), "initialPublishedAt" timestamp(3)
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
`;

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(SCHEMA);
  // PGlite has no replicas: opt out of the lag watch the way an operator would. 'the rescore lag
  // watch' below runs the files without this and expects them to refuse.
  await db.pg.exec(`SET hot_rescore.lag_watch = off`);
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
  preexistingByDownloads = await model(OLD, 3_000, [
    { at: OLD, likes: 3_000 },
    { at: DAY_45, likes: 0, downloads: 192 },
  ]);
  // #9397's backfill walks ids in 250k ranges: one row opening each later range, the last at the
  // max id, each with a mirrored and a measured slice. The head-start rescore batches by position
  // instead (2 at a time here), so these rows also land in its later batches.
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

  it('caps a version without a head start at a brand-new model with 100 engagement published the same day', async () => {
    // Past the 60-day head-start window, so the #9397 cap of 2.0 applies.
    const at = daysAgo(61);
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

  it("does not lend the model's lifetime engagement to a version with none of its own", async () => {
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
    // 2.2: a version with 99 likes qualifies for the head start, whose cap is 2.2.
    const ceiling = Math.round((2.2 + Date.now() / 1000 / MONTH) * 10000);

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
    const ev = 192 / 6.4;
    expect(
      Math.abs((await score(preexistingByDownloads)) - term(ev + 0.01 * (3_000 - ev), DAY_45))
    ).toBeLessThanOrEqual(1);
    expect(mirror.rows[0].hotScore).toBe(await score(preexisting));

    for (const id of BATCH_EDGES) {
      const slices = await db.pg.query<{ baseModel: string; hotScore: number }>(
        `SELECT "baseModel", "hotScore" FROM "ModelBaseModelMetric" WHERE "modelId" = $1`,
        [id]
      );
      const byBase = Object.fromEntries(slices.rows.map((r) => [r.baseModel, r.hotScore]));

      expect(await score(id)).toBe(await score(twin));
      expect(byBase['Mirror']).toBe(await score(twin));
      // The slice's own 12,000 likes give its recent version the full head start, as the twin's.
      expect(byBase['SDXL 1.0']).toBe(await score(twin));
    }
  });

  it("scores a version's downloads, and its generations only past the first generator", async () => {
    // Past the head-start window: this pins the #9397 engagement terms under the 2.0 cap.
    const at = daysAgo(61);
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

/** A term as the trigger computes it: log10(1 + engagement) plus the publish date, at the int scale. */
const term = (engagement: number, at: Date) =>
  Math.round((Math.log10(1 + engagement) + at.getTime() / 1000 / MONTH) * 10000);

describe("Hot gives a proven model's new version a small head start", () => {
  // Model 3,000 likes, version 30: e_v = 30, prior = 0.01 * (3,000 - 30) = 29.7. Both terms sit
  // under their caps, so the score shows exactly which rule applied.
  const withHeadStart = (at: Date) => term(30 + 29.7, at);
  const withoutHeadStart = (at: Date) => term(30, at);
  const old = { at: OLD, likes: 2_970 };

  it("adds 1% of the model's other engagement to a qualifying version", async () => {
    const id = await model(OLD, 3_000, [old, { at: RECENT, likes: 30 }]);

    expect(Math.abs((await score(id)) - withHeadStart(RECENT))).toBeLessThanOrEqual(1);
  });

  it('caps a head start at 2.2, above the 2.0 of a version without one', async () => {
    const id = await model(OLD, 50_000, [
      { at: OLD, likes: 40_000 },
      { at: RECENT, likes: 10_000 },
    ]);
    const cap = Math.round((2.2 + RECENT.getTime() / 1000 / MONTH) * 10000);

    expect(Math.abs((await score(id)) - cap)).toBeLessThanOrEqual(1);
  });

  it('needs 25 likes + downloads / 6.4 of the version itself', async () => {
    const below = await model(OLD, 3_000, [old, { at: RECENT, likes: 24 }]);
    // 24 likes + 7 / 6.4 downloads = 25.09: just over the bar.
    const over = await model(OLD, 3_000, [old, { at: RECENT, likes: 24, downloads: 7 }]);

    expect(Math.abs((await score(below)) - term(24, RECENT))).toBeLessThanOrEqual(1);
    const ev = 24 + 7 / 6.4;
    expect(
      Math.abs((await score(over)) - term(ev + 0.01 * (3_000 - ev), RECENT))
    ).toBeLessThanOrEqual(1);
  });

  it("does not count a version's generations toward the bar", async () => {
    // 5,000 generations from 50 generators is engagement past the 2.0 cap, and no head start.
    const id = await model(OLD, 3_000, [old, { at: RECENT, likes: 0, generations: 5_000 }], {
      uniqueGenerators: 50,
    });
    const cap = Math.round((2.0 + RECENT.getTime() / 1000 / MONTH) * 10000);

    expect(Math.abs((await score(id)) - cap)).toBeLessThanOrEqual(1);
  });

  it('lasts 60 days from publish', async () => {
    const inside = daysAgo(59);
    const outside = daysAgo(61);
    const a = await model(OLD, 3_000, [old, { at: inside, likes: 30 }]);
    const b = await model(OLD, 3_000, [old, { at: outside, likes: 30 }]);

    expect(Math.abs((await score(a)) - withHeadStart(inside))).toBeLessThanOrEqual(1);
    expect(Math.abs((await score(b)) - withoutHeadStart(outside))).toBeLessThanOrEqual(1);
  });

  it('gives no second head start to a version re-dated when its paid-access gate ended', async () => {
    const redated = await model(OLD, 3_000, [
      old,
      { at: RECENT, initial: daysAgo(100), likes: 30 },
    ]);
    const noInitial = await model(OLD, 3_000, [old, { at: RECENT, initial: null, likes: 30 }]);

    expect(Math.abs((await score(redated)) - withoutHeadStart(RECENT))).toBeLessThanOrEqual(1);
    expect(Math.abs((await score(noInitial)) - withHeadStart(RECENT))).toBeLessThanOrEqual(1);
  });

  it('leaves a single-version model on the model term', async () => {
    const id = await model(RECENT, 30, [{ at: RECENT, likes: 30 }]);

    expect(Math.abs((await score(id)) - modelTerm(30, RECENT))).toBeLessThanOrEqual(1);
  });

  it("measures a slice's head start on the slice's own engagement", async () => {
    // Whole model 30,000 likes; the SDXL slice holds 3,000 of them.
    const id = await model(OLD, 30_000, [
      { at: OLD, likes: 27_000, base: 'Flux.1 D' },
      old,
      { at: RECENT, likes: 30 },
    ]);

    expect(
      Math.abs((await slice(id, 'SDXL 1.0', 3_000)) - withHeadStart(RECENT))
    ).toBeLessThanOrEqual(1);
  });
});

describe("an unmeasured slice follows its model's score", () => {
  const MIRROR_DIR = '20271122120000_model_hot_score_mirror_refresh';
  const sliceScore = async (modelId: number, baseModel: string) =>
    (
      await db.pg.query<{ hotScore: number }>(
        `SELECT "hotScore" FROM "ModelBaseModelMetric" WHERE "modelId" = $1 AND "baseModel" = $2`,
        [modelId, baseModel]
      )
    ).rows[0].hotScore;
  const mirrorOf = async (modelId: number) => {
    await db.pg.query(
      `INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "thumbsUpCount") VALUES ($1, 'Mirror', 0)`,
      [modelId]
    );
  };
  const addLikes = (modelId: number, n: number) =>
    db.pg.query(
      `UPDATE "ModelMetric" SET "thumbsUpCount" = "thumbsUpCount" + $2 WHERE "modelId" = $1`,
      [modelId, n]
    );

  it('when only ModelMetric is written', async () => {
    const id = await model(OLD, 100, [{ at: OLD, likes: 100 }]);
    await mirrorOf(id);
    const before = await score(id);

    await addLikes(id, 10_000);

    expect(await score(id)).toBeGreaterThan(before);
    expect(await sliceScore(id, 'Mirror')).toBe(await score(id));
  });

  it('when the slice was written before its ModelMetric row', async () => {
    const id = nextModel++;
    await mirrorOf(id);
    expect(await sliceScore(id, 'Mirror')).toBe(0);

    await model(OLD, 100, [{ at: OLD, likes: 100 }], { id });

    expect(await sliceScore(id, 'Mirror')).toBe(await score(id));
  });

  // Deliberate: the mirror locks are taken at commit so a transaction never holds them while it
  // waits on another slice (deadlock with the base-model job). Do not make the trigger immediate.
  it('at commit, not mid-transaction', async () => {
    const id = await model(OLD, 100, [{ at: OLD, likes: 100 }]);
    await mirrorOf(id);
    const before = await sliceScore(id, 'Mirror');

    await db.pg.exec('BEGIN');
    await addLikes(id, 10_000);
    const midTransaction = await sliceScore(id, 'Mirror');
    await db.pg.exec('COMMIT');

    expect(midTransaction).toBe(before);
    expect(await sliceScore(id, 'Mirror')).toBe(await score(id));
  });

  it('and the migration catches up mirrors already behind, and can be re-run', async () => {
    const id = await model(OLD, 100, [{ at: OLD, likes: 100 }]);
    await mirrorOf(id);
    await db.pg.exec(`ALTER TABLE "ModelMetric" DISABLE TRIGGER trg_model_metric_hot_score_mirror`);
    await addLikes(id, 10_000);
    await db.pg.exec(`ALTER TABLE "ModelMetric" ENABLE TRIGGER trg_model_metric_hot_score_mirror`);
    expect(await sliceScore(id, 'Mirror')).toBeLessThan(await score(id));

    await apply(MIRROR_DIR);

    expect(await sliceScore(id, 'Mirror')).toBe(await score(id));
  });
});

// Puts the shared database's triggers back to #9397: only fresh databases are used after it.
describe('the head-start rollback', () => {
  it('returns a head-started model and its slices to the #9397 score', async () => {
    const at = daysAgo(5);
    const id = await model(OLD, 3_000, [
      { at: OLD, likes: 2_970 },
      { at, likes: 30 },
    ]);
    await db.pg.query(
      `INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "thumbsUpCount") VALUES ($1, 'Mirror', 0)`,
      [id]
    );
    const measured = await slice(id, 'SDXL 1.0', 3_000);
    expect(await score(id)).toBeGreaterThan(term(30, at) + 1);
    expect(measured).toBe(await score(id));

    // Raised, then made private: its versions go to Draft with publishedAt NULL, and nothing rewrites
    // the ModelMetric row. The rollback must still reach it.
    const madePrivate = await model(OLD, 3_000, [
      { at: OLD, likes: 2_970 },
      { at, likes: 30 },
    ]);
    const raised = await score(madePrivate);
    await db.pg.query(
      `UPDATE "ModelVersion" SET status = 'Draft', "publishedAt" = NULL WHERE "modelId" = $1`,
      [madePrivate]
    );
    expect(await score(madePrivate)).toBe(raised);

    await apply('20271121120000_model_hot_score_version_head_start', 'rollback.sql');

    expect(Math.abs((await score(madePrivate)) - modelTerm(3_000, OLD))).toBeLessThanOrEqual(1);

    const slices = await db.pg.query<{ baseModel: string; hotScore: number }>(
      `SELECT "baseModel", "hotScore" FROM "ModelBaseModelMetric" WHERE "modelId" = $1`,
      [id]
    );
    expect(Math.abs((await score(id)) - term(30, at))).toBeLessThanOrEqual(1);
    for (const row of slices.rows) expect(row.hotScore).toBe(await score(id));
  });

  it('can be re-run, which is how a stopped rollback resumes', async () => {
    await expect(
      apply('20271121120000_model_hot_score_version_head_start', 'rollback.sql')
    ).resolves.toBeUndefined();
  });
});

describe('the rescore lag watch', () => {
  // The backstop for a run that ignored the preflight's error: the procedure itself must refuse
  // before its first write. Applied with the opt-out, then the procedure is recreated from the
  // file and called without it.
  it.each([
    [
      'migration.sql',
      /CREATE OR REPLACE PROCEDURE public\.rescore_hot_version_head_start\([\s\S]*?\$procedure\$;/,
      'rescore_hot_version_head_start',
    ],
    [
      'rollback.sql',
      /CREATE OR REPLACE PROCEDURE public\.rescore_hot_version_head_start_rollback\([\s\S]*?\$procedure\$;/,
      'rescore_hot_version_head_start_rollback',
    ],
  ])(
    'the %s procedure refuses before writing when it cannot see replica lag',
    async (file, re, proc) => {
      const procedure = readFileSync(path.join(MIGRATIONS, HEAD_START, file), 'utf8').match(
        re
      )?.[0];
      const id = await model(OLD, 3_000, [
        { at: OLD, likes: 2_970 },
        { at: RECENT, likes: 30 },
      ]);
      // Knock the stored score down without firing the trigger, so a rescore would visibly raise it.
      await db.pg.query(`UPDATE "ModelMetric" SET "hotScore" = 1 WHERE "modelId" = $1`, [id]);
      await db.pg.exec(procedure ?? 'SELECT missing_procedure()');

      await db.pg.exec(`RESET hot_rescore.lag_watch`);
      try {
        await expect(db.pg.exec(`CALL public.${proc}()`)).rejects.toThrow('no replica lag visible');
      } finally {
        await db.pg.exec(`SET hot_rescore.lag_watch = off`);
      }
      expect(await score(id)).toBe(1);
    }
  );

  const HEAD_START = HEAD_START_DIR;
  const functionExists = async (pg: PGlite, name: string) =>
    (await pg.query(`SELECT 1 FROM pg_proc WHERE proname = $1`, [name])).rows.length > 0;

  // Run as written, on a database with no replicas and no opt-out: each file must stop before it
  // changes anything.
  /** A database at the given point of the hot-score history, applied with the lag watch waived. */
  async function freshDb(through: string) {
    const pg = new PGlite();
    await pg.exec(SCHEMA);
    await pg.exec(`SET hot_rescore.lag_watch = off`);
    for (const dir of [...BASELINE, ...LATER].filter((d) => d <= through))
      await apply(dir, 'migration.sql', pg);
    await pg.exec(`RESET hot_rescore.lag_watch`);
    return pg;
  }
  // PGlite reports a failed chunk by its last error ("current transaction is aborted"), not the
  // guard's, so the guard is asserted by running the file's own preflight alone. A file broken for
  // another reason fails every other test here, which apply it with the opt-out.
  const preflight = (file: string) =>
    readFileSync(path.join(MIGRATIONS, HEAD_START, file), 'utf8').match(
      /DO \$preflight\$[\s\S]*?\$preflight\$;/
    )?.[0] ?? 'SELECT missing_preflight()';
  const usesHeadStart = async (pg: PGlite) =>
    (
      await pg.query(
        `SELECT 1 FROM pg_proc WHERE proname = 'model_metric_hot_score' AND prosrc LIKE '%hot_version_score%'`
      )
    ).rows.length > 0;

  // Run as written, with no replicas and no opt-out: each file must stop before it changes anything.
  // PGlite runs each chunk as one implicit transaction, so the explicit BEGIN that protects a psql
  // run without ON_ERROR_STOP is exercised by the statement-by-statement test below, not here.
  it('refuses to apply the migration, changing nothing, when it cannot see replica lag', async () => {
    const pg = await freshDb('20271117190000_model_hot_score_version_credit');

    await expect(apply(HEAD_START, 'migration.sql', pg)).rejects.toThrow();
    await pg.exec('ROLLBACK');
    await expect(pg.exec(preflight('migration.sql'))).rejects.toThrow('no replica lag visible');
    expect(await functionExists(pg, 'hot_version_score')).toBe(false);
    expect(await usesHeadStart(pg)).toBe(false);
    await pg.close();
  });

  // The transaction wrap: without ON_ERROR_STOP psql carries on past the refusal, and only the
  // explicit BEGIN keeps the trigger functions from being replaced.
  it('changes nothing when run without ON_ERROR_STOP and refused', async () => {
    const pg = await freshDb('20271117190000_model_hot_score_version_credit');

    const errors = await applyLikePsqlWithoutErrorStop(pg, 'migration.sql');

    expect(errors[0]).toContain('no replica lag visible');
    expect(await functionExists(pg, 'hot_version_score')).toBe(false);
    expect(await usesHeadStart(pg)).toBe(false);
    await pg.close();
  });

  it('refuses to apply the rollback, changing nothing, when it cannot see replica lag', async () => {
    const pg = await freshDb(HEAD_START);
    expect(await usesHeadStart(pg)).toBe(true);

    await expect(apply(HEAD_START, 'rollback.sql', pg)).rejects.toThrow();
    await pg.exec('ROLLBACK');
    await expect(pg.exec(preflight('rollback.sql'))).rejects.toThrow('no replica lag visible');
    expect(await functionExists(pg, 'hot_version_score')).toBe(true);
    expect(await usesHeadStart(pg)).toBe(true);
    await pg.close();
  });
});
