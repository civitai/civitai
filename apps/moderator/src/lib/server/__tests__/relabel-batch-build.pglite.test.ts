import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import {
  buildRelabelBatch,
  parseBands,
  type ClickhouseQuery,
  type RelabelBuildOptions,
} from '../relabel-batch-build';
import { pgliteDialect } from './abuse-detection-pglite.harness';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODERATOR_SCHEMA = readFileSync(
  join(HERE, '../../../../removal-label-eval/schema.sql'),
  'utf8'
);

// The main-database tables the build reads, cut to the columns it touches.
const MAIN_TABLES = `
CREATE TABLE "Image" (
  id int PRIMARY KEY, "userId" int NOT NULL, ingestion text NOT NULL, "needsReview" text,
  "blockedFor" text, "nsfwLevel" int NOT NULL DEFAULT 1, type text NOT NULL DEFAULT 'image'
);
CREATE TABLE "Report" (id int PRIMARY KEY, reason text NOT NULL);
CREATE TABLE "ImageReport" ("reportId" int NOT NULL, "imageId" int NOT NULL);
CREATE TABLE "UserReport" ("reportId" int NOT NULL, "userId" int NOT NULL);
CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]');
CREATE TABLE "Appeal" (
  id serial PRIMARY KEY, "entityId" int NOT NULL, "entityType" text NOT NULL, status text NOT NULL,
  "resolvedAt" timestamp, "createdAt" timestamp NOT NULL DEFAULT now()
);
`;

let mainPg: PGlite;
let modPg: PGlite;
let replica: Kysely<MainDB>;
let moderator: Kysely<ModeratorDB>;
let moderatorSql: string[];

type Removal = { imageId: number | string; bucket: string; nsfw: string };
let removals: Removal[];
let scores: { id: number; score: number }[];
let chQueries: string[];

const clickhouse: ClickhouseQuery = async <T extends object>(query: string) => {
  chQueries.push(query);
  if (query.includes('FROM images'))
    return removals.map((r) => ({
      imageId: r.imageId,
      bucket: r.bucket,
      removedAt: 1_790_000_000,
      removedBy: 7,
      nsfw: r.nsfw,
    })) as unknown as T[];
  if (query.includes('FROM scanner_label_results'))
    return scores.map((s) => ({ ids: [String(s.id)], score: s.score })) as unknown as T[];
  throw new Error(`unexpected ClickHouse query: ${query}`);
};

const build = (over: Partial<RelabelBuildOptions> = {}) =>
  buildRelabelBatch(
    {
      batch: '2026-10-03',
      removed: 3,
      notRemoved: 2,
      days: 5,
      bands: [0.5],
      dryRun: false,
      ...over,
    },
    { clickhouse, replica, moderator }
  );

const itemIds = async () =>
  (await moderator.selectFrom('relabel_item').select('image_id').orderBy('image_id').execute()).map(
    (r) => r.image_id
  );

/** Removed images 1..n, one owner each, all in one stratum so only the cap limits a run. */
async function seedRemovals(n: number) {
  removals = [];
  for (let id = 1; id <= n; id++) {
    await mainPg.query(
      `INSERT INTO "Image" (id, "userId", ingestion, "blockedFor") VALUES ($1, $2, 'Blocked', 'moderated')`,
      [id, 100 + id]
    );
    removals.push({ imageId: id, bucket: 'animatedMinorNsfw', nsfw: 'Soft' });
  }
}

/** Scanned, unremoved images 101..100+n, one owner each. */
async function seedScanned(n: number, score = 0.7) {
  scores = [];
  for (let id = 101; id <= 100 + n; id++) {
    await mainPg.query(`INSERT INTO "Image" (id, "userId", ingestion) VALUES ($1, $2, 'Scanned')`, [
      id,
      1000 + id,
    ]);
    scores.push({ id, score });
  }
}

// One instance per database for the file: PGlite takes seconds to boot.
beforeAll(async () => {
  mainPg = await PGlite.create();
  await mainPg.exec(MAIN_TABLES);
  modPg = await PGlite.create();
  await modPg.exec(MODERATOR_SCHEMA);
  replica = new Kysely<MainDB>({ dialect: pgliteDialect(mainPg) });
  moderator = new Kysely<ModeratorDB>({
    dialect: pgliteDialect(modPg),
    log: (e) => {
      if (e.level === 'query') moderatorSql.push(e.query.sql);
    },
  });
}, 60_000);

beforeEach(async () => {
  await mainPg.exec(
    'TRUNCATE "Image", "Report", "ImageReport", "UserReport", "CsamReport", "Appeal"'
  );
  await modPg.exec('TRUNCATE relabel_item RESTART IDENTITY CASCADE');
  removals = [];
  scores = [];
  chQueries = [];
  moderatorSql = [];
});

describe('buildRelabelBatch', () => {
  it('writes both strata under the batch name, up to each cap', async () => {
    await seedRemovals(5);
    await seedScanned(4);
    const summary = await build();
    expect(summary.picked).toEqual({ removed: 3, notRemoved: 2 });
    expect(summary.inserted).toBe(5);
    const rows = await moderator
      .selectFrom('relabel_item')
      .select(['batch', 'stratum', 'relabel'])
      .execute();
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => `${r.batch}|${r.relabel}`))).toEqual(
      new Set(['2026-10-03|true'])
    );
  });

  // Decision: the caps bound the BATCH, so a scheduler retry, a manual re-run or a second fire on
  // the same day adds nothing once the day is full. A cap per run would double the day on a retry.
  it('adds nothing on a re-run of a complete batch, though candidates remain', async () => {
    await seedRemovals(8);
    await seedScanned(6);
    expect((await build()).inserted).toBe(5);

    const again = await build();
    expect(again.alreadyInBatch).toEqual({ removed: 3, notRemoved: 2 });
    expect(again.picked).toEqual({ removed: 0, notRemoved: 0 });
    expect(again.inserted).toBe(0);
    expect(await itemIds()).toHaveLength(5);
  });

  it('finishes a batch a crashed run left short, and no further', async () => {
    await seedRemovals(8);
    await moderator
      .insertInto('relabel_item')
      .values({
        batch: '2026-10-03',
        image_id: 1,
        stratum: 'removed',
        bucket: 'animatedMinorNsfw',
        nsfw_level: 'Soft',
        stratum_key: 'animatedMinorNsfw:Soft',
        owner_id: 101,
      })
      .execute();
    const summary = await build({ bands: null });
    expect(summary.inserted).toBe(2);
    expect(await itemIds()).toHaveLength(3);
  });

  it("does not count another day's batch against today's cap", async () => {
    await seedRemovals(8);
    await build({ batch: '2026-10-02', bands: null });
    expect((await build({ bands: null })).inserted).toBe(3);
  });

  // The count and the inserts run under a per-batch advisory lock, so two runs of one day cannot
  // both read the same shortfall. PGlite is a single session, where the lock is re-entrant and two
  // runs cannot interleave, so the race itself is not reproducible here; this pins that the lock is
  // taken, on this batch's key, before the batch is counted.
  it('takes the per-batch lock before counting the batch', async () => {
    await seedRemovals(4);
    await build({ bands: null });
    const lock = moderatorSql.findIndex((q) => q.includes('pg_advisory_xact_lock'));
    const count = moderatorSql.findIndex(
      (q) => q.includes('count(*)') && q.includes('relabel_item')
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(count).toBeGreaterThan(lock);
  });

  it('never queries the scanner pool or samples not-removed items without bands', async () => {
    await seedRemovals(2);
    await seedScanned(3);
    const summary = await build({ bands: null });
    expect(summary.notRemovedSkipped).toBe('bands unset');
    expect(summary.picked.notRemoved).toBe(0);
    expect(chQueries.some((q) => q.includes('scanner_label_results'))).toBe(false);
  });

  it('writes nothing on a dry run, and still reports what it would pick', async () => {
    await seedRemovals(4);
    const summary = await build({ dryRun: true, bands: null });
    expect(summary.picked.removed).toBe(3);
    expect(summary.inserted).toBe(0);
    expect(await itemIds()).toEqual([]);
  });

  it('excludes images a CSAM signal touches, from both strata', async () => {
    await seedRemovals(2);
    await seedScanned(2);
    // Owner of removed image 1, and owner of scanned image 101.
    await mainPg.exec(`INSERT INTO "CsamReport" ("userId") VALUES (101), (1101)`);
    const summary = await build();
    expect(summary.csamExcluded).toEqual({ removed: 1, notRemoved: 1 });
    expect(await itemIds()).toEqual([2, 102]);
  });

  // ClickHouse returns a 64-bit column as a quoted string. Left as a string, the id would match no
  // numeric Set, the CSAM exclusion among them, and a CSAM-touched image would be written.
  it('excludes a CSAM-touched image whose id arrived from ClickHouse as a string', async () => {
    await seedRemovals(2);
    removals = removals.map((r) => ({ ...r, imageId: String(r.imageId) }));
    await mainPg.exec(`INSERT INTO "CsamReport" ("userId") VALUES (101)`);
    await build({ bands: null });
    expect(await itemIds()).toEqual([2]);
  });

  it('skips a removal whose image is no longer blocked', async () => {
    await seedRemovals(2);
    await mainPg.exec(`UPDATE "Image" SET ingestion = 'Scanned' WHERE id = 1`);
    await build({ bands: null });
    expect(await itemIds()).toEqual([2]);
  });

  it('refuses a window reaching past the purge', async () => {
    await expect(build({ days: 7 })).rejects.toThrow(/days must be 1-6/);
  });
});

describe('parseBands', () => {
  it('reads unset or empty as no bands', () => {
    expect(parseBands(undefined)).toBeNull();
    expect(parseBands(' ')).toBeNull();
  });

  it('sorts edges', () => {
    expect(parseBands('0.6, 0.2')).toEqual([0.2, 0.6]);
  });

  it('refuses an edge outside (0, 1)', () => {
    expect(() => parseBands('0.2,1')).toThrow(/bands/);
    expect(() => parseBands('x')).toThrow(/bands/);
  });
});
