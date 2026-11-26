import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EARLY_ACCESS_PURCHASES } from '~/server/services/model-version-access.service';

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
  /** "EntityAccess" rows for the version, written before the metrics. */
  access?: Access[];
  /** The version's "PaidAccess" terms, written before the metrics. */
  gate?: Record<string, unknown>;
};

type Access = { user: number; meta: Record<string, unknown> };
const OWNER = 1;
const DOWNLOAD_KEY = 'download-buzzTransactionId';
const GENERATION_KEY = 'generation-buzzTransactionId';
let nextBuyer = 10_000;
/** `n` paid buyers of a version, each a different user. */
const paid = (n: number, key = DOWNLOAD_KEY): Access[] =>
  Array.from({ length: n }, () => ({ user: nextBuyer++, meta: { [key]: 'tx' } }));
const [DOWNLOAD, GENERATION] = EARLY_ACCESS_PURCHASES;
/** `n` buyers of a version, each recording what they paid, as a purchase writes it. */
const bought = (
  n: number,
  amount: unknown,
  { kind = DOWNLOAD as (typeof EARLY_ACCESS_PURCHASES)[number], buzzType = 'yellow' } = {}
): Access[] =>
  Array.from({ length: n }, () => ({
    user: nextBuyer++,
    meta: { [kind.transactionKey]: 'tx', [kind.amountKey]: amount, [kind.buzzTypeKey]: buzzType },
  }));

let nextModel = 1;
/** Writes versions first, as the metrics job does, then the ModelMetric row the trigger scores. */
async function model(
  published: Date,
  likes: number,
  versions: Version[],
  opts: { id?: number; uniqueGenerators?: number } = {}
) {
  const modelId = opts.id ?? nextModel++;
  await db.pg.query(`INSERT INTO "Model" (id, "userId") VALUES ($1, $2)`, [modelId, OWNER]);
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
    if (v.gate)
      await db.pg.query(
        `INSERT INTO "PaidAccess" ("entityType", "entityId", terms) VALUES ('ModelVersion', $1, $2)`,
        [id, JSON.stringify(v.gate)]
      );
    for (const a of v.access ?? [])
      await db.pg.query(
        `INSERT INTO "EntityAccess" ("accessToId", "accessToType", "accessorId", "accessorType", meta)
         VALUES ($1, 'ModelVersion', $2, 'User', $3)`,
        [id, a.user, JSON.stringify(a.meta)]
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
// Under the bar on likes + downloads, over it with its buyers: only the buyer-bar rescore lifts it.
let preexistingByBuyers: number;
// Under the bar counting each buyer as 1, over it weighting them by price: only the price rescore.
let preexistingByPrice: number;

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
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "EntityAccess" (
      "accessToId" int NOT NULL, "accessToType" text NOT NULL,
      "accessorId" int NOT NULL, "accessorType" text NOT NULL, meta jsonb DEFAULT '{}',
      PRIMARY KEY ("accessToId", "accessToType", "accessorId", "accessorType")
    );
    CREATE TABLE "PaidAccess" (
      "entityType" text NOT NULL, "entityId" int NOT NULL, terms jsonb NOT NULL,
      PRIMARY KEY ("entityType", "entityId")
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
  // A generation purchase too, so the rescore's candidate scan must count both keys.
  preexistingByBuyers = await model(OLD, 3_000, [
    { at: OLD, likes: 2_970 },
    { at: RECENT, likes: 19, access: [...paid(5), ...paid(1, GENERATION_KEY)] },
  ]);
  preexistingByPrice = await model(OLD, 3_000, [
    { at: OLD, likes: 2_984 },
    { at: RECENT, likes: 16, access: bought(3, 20_000) },
  ]);
  await db.pg.query(
    `INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "thumbsUpCount", "generationCount", "uniqueGeneratorCount")
     VALUES ($1, 'SDXL 1.0', 3000, 0, 0), ($1, 'Mirror', 0, NULL, NULL)`,
    [preexistingByPrice]
  );
  // A measured slice the rescore must rewrite, and a mirror that follows ModelMetric.
  await db.pg.query(
    `INSERT INTO "ModelBaseModelMetric" ("modelId", "baseModel", "thumbsUpCount", "generationCount", "uniqueGeneratorCount")
     VALUES ($1, 'SDXL 1.0', 3000, 0, 0), ($1, 'Mirror', 0, NULL, NULL)`,
    [preexistingByBuyers]
  );
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

const PRICE_WEIGHT_DIR = '20271128120100_model_hot_score_buyer_price_weight';

describe('a buyer counts toward the head-start bar by what they paid, capped', () => {
  // The rule is docs/model-feed-hot-ranking.md §21: change it there first. A buyer paying p Buzz
  // counts least(1 + log2(max(p, 100) / 100) / 3, 3): 100 = 1, 800 = 2, 6,400 and up = 3. As §20,
  // the model has 3,000 likes and the buyers move the bar only.
  const headStart = (ev: number) => term(ev + 0.01 * (3_000 - ev), RECENT);
  const noHeadStart = (ev: number) => term(ev, RECENT);
  const expectNear = async (id: number, want: number) =>
    expect(Math.abs((await score(id)) - want)).toBeLessThanOrEqual(1);
  /** A model whose recent version has `likes` likes and these buyers; reports if it qualified. */
  const qualifies = async (likes: number, v: Partial<Version>) => {
    const id = await model(OLD, 3_000, [
      { at: OLD, likes: 3_000 - likes },
      { at: RECENT, likes, ...v },
    ]);
    const s = await score(id);
    const ev = likes + (v.downloads ?? 0) / 6.4;
    if (Math.abs(s - headStart(ev)) <= 1) return true;
    expect(Math.abs(s - noHeadStart(ev))).toBeLessThanOrEqual(1);
    return false;
  };

  it('counts a buyer at 20,000 Buzz as 3', async () => {
    // 16 likes + 3 * 3 = 25. Counted as 1 each, 19.
    expect(await qualifies(16, { access: bought(3, 20_000) })).toBe(true);
    expect(await qualifies(15, { access: bought(3, 20_000) })).toBe(false);
  });

  it('caps a buyer at 3 however much they paid', async () => {
    // 12 likes + 4 * 3 = 24. Uncapped, 1,000,000 Buzz would weigh 5.4 each.
    expect(await qualifies(12, { access: bought(4, 1_000_000) })).toBe(false);
    expect(await qualifies(13, { access: bought(4, 1_000_000) })).toBe(true);
  });

  it('follows the log curve between 100 and the cap', async () => {
    // 800 Buzz = 1 + log2(8) / 3 = 2: 13 likes + 6 * 2 = 25.
    expect(await qualifies(13, { access: bought(6, 800) })).toBe(true);
    expect(await qualifies(12, { access: bought(6, 800) })).toBe(false);
  });

  it('counts a buyer at 100 Buzz or less as 1, as before', async () => {
    expect(await qualifies(19, { access: [...bought(3, 100), ...bought(3, 0)] })).toBe(true);
    expect(await qualifies(18, { access: [...bought(3, 100), ...bought(3, 1)] })).toBe(false);
  });

  it('counts a Blue Buzz purchase as 1 whatever its price, since Blue is earned, not bought', async () => {
    expect(await qualifies(16, { access: bought(3, 20_000, { buzzType: 'blue' }) })).toBe(false);
    expect(await qualifies(22, { access: bought(3, 20_000, { buzzType: 'blue' }) })).toBe(true);
  });

  it('weighs a generation purchase by its own amount', async () => {
    const access = bought(3, 20_000, { kind: GENERATION });
    expect(await qualifies(16, { access })).toBe(true);
  });

  it('counts a buyer with both purchases once, at the dearer one', async () => {
    const both = (generation: number, download: number) => ({
      user: nextBuyer++,
      meta: {
        ...bought(1, generation, { kind: GENERATION })[0].meta,
        ...bought(1, download)[0].meta,
      },
    });
    const access = [both(200, 20_000), both(200, 20_000), both(200, 20_000)];
    // 16 + 3 * 3 = 25; adding both purchases would be 16 + 3 * (3 + 1.33) = 29.
    expect(await qualifies(16, { access })).toBe(true);
    expect(
      await qualifies(15, { access: [both(200, 20_000), both(200, 20_000), both(200, 20_000)] })
    ).toBe(false);
  });

  describe('a purchase made before the amount was recorded', () => {
    it("takes the gate's current price for that kind", async () => {
      expect(await qualifies(16, { access: paid(3), gate: { download: { price: 20_000 } } })).toBe(
        true
      );
      // Generation without a price of its own costs the download price.
      const generation = { download: { price: 20_000 }, generation: { trialLimit: 10 } };
      expect(await qualifies(16, { access: paid(3, GENERATION_KEY), gate: generation })).toBe(true);
      const cheaper = { download: { price: 20_000 }, generation: { price: 100 } };
      expect(await qualifies(16, { access: paid(3, GENERATION_KEY), gate: cheaper })).toBe(false);
    });

    it('counts 1 when the gate accepts Blue Buzz, since the currency paid is unknown', async () => {
      const gate = { download: { price: 20_000 }, acceptsBlueBuzz: true };
      expect(await qualifies(16, { access: paid(3), gate })).toBe(false);
    });

    it('counts 1 with no gate, or no usable price on it', async () => {
      expect(await qualifies(16, { access: paid(3) })).toBe(false);
      expect(await qualifies(19, { access: paid(6) })).toBe(true);
      const unusable = { download: { price: 'lots' }, generation: { free: true } };
      expect(await qualifies(16, { access: paid(3), gate: unusable })).toBe(false);
      expect(await qualifies(16, { access: paid(3, GENERATION_KEY), gate: unusable })).toBe(false);
    });
  });

  it('scores an unreadable recorded amount as 1 rather than failing the metrics write', async () => {
    expect(await qualifies(19, { access: [...bought(3, 'abc'), ...bought(3, null)] })).toBe(true);
    expect(
      await qualifies(16, { access: bought(3, 'abc'), gate: { download: { price: 20_000 } } })
    ).toBe(false);
  });

  it("still counts a buyer in place of a download, and never the owner's purchase", async () => {
    // 9 likes + (7 - 5) / 6.4 + 5 * 3 = 24.3. Counting the owner too: 9 + 1 / 6.4 + 6 * 3 = 27.2.
    const owner = { user: OWNER, meta: bought(1, 20_000)[0].meta };
    expect(await qualifies(9, { downloads: 7, access: [...bought(5, 20_000), owner] })).toBe(false);
    expect(await qualifies(10, { downloads: 7, access: bought(5, 20_000) })).toBe(true);
  });

  it('measures a slice on its own versions with the same weights', async () => {
    const id = await model(OLD, 3_000, [
      { at: OLD, likes: 2_984 },
      { at: RECENT, likes: 16, access: bought(3, 20_000) },
    ]);
    expect(Math.abs((await slice(id, 'SDXL 1.0', 3_000)) - headStart(16))).toBeLessThanOrEqual(1);
  });

  it("reads exactly the app's purchase keys", () => {
    const sql = readFileSync(path.join(MIGRATIONS, PRICE_WEIGHT_DIR, 'migration.sql'), 'utf8');
    const used = new Set(
      [...sql.matchAll(/'((?:download|generation)-[A-Za-z]+)'/g)].map((m) => m[1])
    );
    const app = EARLY_ACCESS_PURCHASES.flatMap((p) => [
      p.transactionKey,
      p.amountKey,
      p.buzzTypeKey,
    ]);
    expect([...used].sort()).toEqual([...app].sort());
  });

  const slicesOf = async (id: number) =>
    Object.fromEntries(
      (
        await db.pg.query<{ baseModel: string; hotScore: number }>(
          `SELECT "baseModel", "hotScore" FROM "ModelBaseModelMetric" WHERE "modelId" = $1`,
          [id]
        )
      ).rows.map((r) => [r.baseModel, r.hotScore])
    );

  it('backfills a model scored before the migration, and its slices', async () => {
    await expectNear(preexistingByPrice, headStart(16));
    const slices = await slicesOf(preexistingByPrice);
    expect(Math.abs(slices['SDXL 1.0'] - headStart(16))).toBeLessThanOrEqual(1);
    expect(slices['Mirror']).toBe(await score(preexistingByPrice));
  });

  it('can be re-run, which is how a stopped rescore resumes', async () => {
    await expect(apply(PRICE_WEIGHT_DIR)).resolves.toBeUndefined();
    await expectNear(preexistingByPrice, headStart(16));
  });

  it('the rollback returns a price-lifted model to the §20 score, and can be re-run', async () => {
    const id = await model(OLD, 3_000, [
      { at: OLD, likes: 2_984 },
      { at: RECENT, likes: 16, access: bought(3, 20_000) },
    ]);
    await expectNear(id, headStart(16));
    const counted = await model(OLD, 3_000, [
      { at: OLD, likes: 2_981 },
      { at: RECENT, likes: 19, access: bought(6, 20_000) },
    ]);

    await apply(PRICE_WEIGHT_DIR, 'rollback.sql');

    await expectNear(id, noHeadStart(16));
    await expectNear(preexistingByPrice, noHeadStart(16));
    const slices = await slicesOf(preexistingByPrice);
    expect(Math.abs(slices['SDXL 1.0'] - noHeadStart(16))).toBeLessThanOrEqual(1);
    expect(slices['Mirror']).toBe(await score(preexistingByPrice));
    // Back on §20: 19 likes + 6 buyers counted as 1 each still qualifies.
    await expectNear(counted, headStart(19));
    await expect(apply(PRICE_WEIGHT_DIR, 'rollback.sql')).resolves.toBeUndefined();
    // Re-applied, for the §20 tests below, which run on whichever functions are live.
    await apply(PRICE_WEIGHT_DIR);
    await expectNear(id, headStart(16));
  });
});

const BUYER_BAR_DIR = '20271123120000_model_hot_score_buyer_bar';

describe('paid buyers count toward the head-start bar like likes', () => {
  // The rule is docs/model-feed-hot-ranking.md §20 (civitai/civitai#10034): change it there first.
  // As the head-start fixtures: model 3,000 likes, so a qualifying version of engagement e scores
  // term(e + 0.01 * (3,000 - e)). The buyers move the bar only, never e.
  const old = { at: OLD, likes: 2_970 };
  const headStart = (ev: number) => term(ev + 0.01 * (3_000 - ev), RECENT);
  const noHeadStart = (ev: number) => term(ev, RECENT);
  const expectNear = async (id: number, want: number) =>
    expect(Math.abs((await score(id)) - want)).toBeLessThanOrEqual(1);

  it('lifts a version over the bar on its buyers, download and generation purchases alike', async () => {
    // 19 likes + 6 buyers = 25. Without either kind of purchase it stays under.
    const id = await model(OLD, 3_000, [
      old,
      { at: RECENT, likes: 19, access: [...paid(5), ...paid(1, GENERATION_KEY)] },
    ]);

    await expectNear(id, headStart(19));
    expect(Math.abs((await slice(id, 'SDXL 1.0', 3_000)) - headStart(19))).toBeLessThanOrEqual(1);
  });

  it('keeps the head start of a version over the bar on its own', async () => {
    const id = await model(OLD, 3_000, [old, { at: RECENT, likes: 30, access: paid(6) }]);

    await expectNear(id, headStart(30));
  });

  it("counts exactly the app's purchase kinds, in every copy of the buyer filter", () => {
    const sql = readFileSync(path.join(MIGRATIONS, BUYER_BAR_DIR, 'migration.sql'), 'utf8');
    const copies = [...sql.matchAll(/ea\.meta \?\| array\[([^\]]*)\]/g)].map((m) =>
      [...m[1].matchAll(/'([^']+)'/g)].map((k) => k[1]).sort()
    );
    const keys = EARLY_ACCESS_PURCHASES.map((p) => p.transactionKey).sort();

    expect(copies).toEqual([keys, keys, keys]);
  });

  it('scores a version with no buyers as before', async () => {
    const id = await model(OLD, 3_000, [old, { at: RECENT, likes: 19 }]);

    await expectNear(id, noHeadStart(19));
  });

  it("does not count the owner's own purchase", async () => {
    const id = await model(OLD, 3_000, [
      old,
      {
        at: RECENT,
        likes: 19,
        access: [...paid(5), { user: OWNER, meta: { [DOWNLOAD_KEY]: 'tx' } }],
      },
    ]);

    await expectNear(id, noHeadStart(19));
    expect(Math.abs((await slice(id, 'SDXL 1.0', 3_000)) - noHeadStart(19))).toBeLessThanOrEqual(1);
  });

  it('does not count a gift or a revoked purchase, which hold no purchase key', async () => {
    const id = await model(OLD, 3_000, [
      old,
      {
        at: RECENT,
        likes: 19,
        access: [
          ...paid(5),
          { user: nextBuyer++, meta: { giftLinkId: 'gift' } },
          // A moderator revoke moves the purchase keys into an archived entry.
          { user: nextBuyer++, meta: { revocations: [{ [DOWNLOAD_KEY]: 'tx', revokedById: 2 }] } },
        ],
      },
    ]);

    await expectNear(id, noHeadStart(19));
    expect(Math.abs((await slice(id, 'SDXL 1.0', 3_000)) - noHeadStart(19))).toBeLessThanOrEqual(1);
  });

  it('counts a buyer in place of a download, not on top of one', async () => {
    // 18 likes + (7 - 6) / 6.4 + 6 buyers = 24.16. Counting the buyers' downloads too: 25.09.
    const id = await model(OLD, 3_000, [
      old,
      { at: RECENT, likes: 18, downloads: 7, access: paid(6) },
    ]);

    await expectNear(id, noHeadStart(18 + 7 / 6.4));
  });

  const slicesOf = async (id: number) =>
    Object.fromEntries(
      (
        await db.pg.query<{ baseModel: string; hotScore: number }>(
          `SELECT "baseModel", "hotScore" FROM "ModelBaseModelMetric" WHERE "modelId" = $1`,
          [id]
        )
      ).rows.map((r) => [r.baseModel, r.hotScore])
    );

  it('backfills a model scored before the migration, and its slices', async () => {
    await expectNear(preexistingByBuyers, headStart(19));
    const slices = await slicesOf(preexistingByBuyers);
    expect(Math.abs(slices['SDXL 1.0'] - headStart(19))).toBeLessThanOrEqual(1);
    expect(slices['Mirror']).toBe(await score(preexistingByBuyers));
  });

  it('can be re-run, which is how a stopped rescore resumes', async () => {
    await expect(apply(BUYER_BAR_DIR)).resolves.toBeUndefined();
    await expectNear(preexistingByBuyers, headStart(19));
  });

  it('the rollback returns a buyer-lifted model to the #9928 score, and can be re-run', async () => {
    const id = await model(OLD, 3_000, [old, { at: RECENT, likes: 19, access: paid(6) }]);
    await expectNear(id, headStart(19));

    await apply(BUYER_BAR_DIR, 'rollback.sql');

    await expectNear(id, noHeadStart(19));
    await expectNear(preexistingByBuyers, noHeadStart(19));
    const slices = await slicesOf(preexistingByBuyers);
    expect(Math.abs(slices['SDXL 1.0'] - noHeadStart(19))).toBeLessThanOrEqual(1);
    expect(slices['Mirror']).toBe(await score(preexistingByBuyers));
    await expect(apply(BUYER_BAR_DIR, 'rollback.sql')).resolves.toBeUndefined();
    // Back on #9928: a version over the bar on its own still gets its head start.
    const own = await model(OLD, 3_000, [old, { at: RECENT, likes: 30 }]);
    await expectNear(own, headStart(30));
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
      HEAD_START_DIR,
      'migration.sql',
      /CREATE OR REPLACE PROCEDURE public\.rescore_hot_version_head_start\([\s\S]*?\$procedure\$;/,
      'rescore_hot_version_head_start',
    ],
    [
      HEAD_START_DIR,
      'rollback.sql',
      /CREATE OR REPLACE PROCEDURE public\.rescore_hot_version_head_start_rollback\([\s\S]*?\$procedure\$;/,
      'rescore_hot_version_head_start_rollback',
    ],
    [
      BUYER_BAR_DIR,
      'rollback.sql',
      /CREATE OR REPLACE PROCEDURE public\.rescore_hot_version_buyer_bar_rollback\([\s\S]*?\$procedure\$;/,
      'rescore_hot_version_buyer_bar_rollback',
    ],
    [
      PRICE_WEIGHT_DIR,
      'rollback.sql',
      /CREATE OR REPLACE PROCEDURE public\.rescore_hot_version_price_weight_rollback\([\s\S]*?\$procedure\$;/,
      'rescore_hot_version_price_weight_rollback',
    ],
  ])(
    'the %s %s procedure refuses before writing when it cannot see replica lag',
    async (dir, file, re, proc) => {
      const procedure = readFileSync(path.join(MIGRATIONS, dir, file), 'utf8').match(re)?.[0];
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
  const preflightOf = (dir: string, file: string) =>
    readFileSync(path.join(MIGRATIONS, dir, file), 'utf8').match(
      /DO \$preflight\$[\s\S]*?\$preflight\$;/
    )?.[0] ?? 'SELECT missing_preflight()';
  const preflight = (file: string) => preflightOf(HEAD_START, file);
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

  it('refuses to apply the buyer bar, changing nothing, when it cannot see replica lag', async () => {
    const pg = await freshDb('20271122120000_model_hot_score_mirror_refresh');
    const countsBuyers = async () =>
      (
        await pg.query(
          `SELECT 1 FROM pg_proc WHERE proname = 'model_metric_hot_score' AND prosrc LIKE '%EntityAccess%'`
        )
      ).rows.length > 0;

    await expect(apply(BUYER_BAR_DIR, 'migration.sql', pg)).rejects.toThrow();
    await pg.exec('ROLLBACK');
    expect(await countsBuyers()).toBe(false);
    for (const file of ['migration.sql', 'rollback.sql'])
      await expect(pg.exec(preflightOf(BUYER_BAR_DIR, file))).rejects.toThrow(
        'no replica lag visible'
      );
    expect(await usesHeadStart(pg)).toBe(true);
    await pg.close();
  });

  it('refuses to apply the price weight, changing nothing, when it cannot see replica lag', async () => {
    const pg = await freshDb(BUYER_BAR_DIR);
    const weighsBuyers = async () =>
      (
        await pg.query(
          `SELECT 1 FROM pg_proc WHERE proname = 'model_metric_hot_score' AND prosrc LIKE '%PaidAccess%'`
        )
      ).rows.length > 0;
    expect(await usesHeadStart(pg)).toBe(true);

    await expect(apply(PRICE_WEIGHT_DIR, 'migration.sql', pg)).rejects.toThrow();
    await pg.exec('ROLLBACK');
    expect(await weighsBuyers()).toBe(false);
    for (const file of ['migration.sql', 'rollback.sql'])
      await expect(pg.exec(preflightOf(PRICE_WEIGHT_DIR, file))).rejects.toThrow(
        'no replica lag visible'
      );
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
