import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, type DatabaseConnection, type Dialect } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DB as MainDB } from '@civitai/db-schema/kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import {
  CSAM_EXCLUSION_CHUNK,
  buildRelabelBatch,
  parseBands,
  relabelBuildBatchAction,
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

type Logged = { conn: number; sql: string; params: readonly unknown[] };

/**
 * The shared PGlite dialect, with every acquired connection numbered. PGlite is one session, so the
 * shared harness hands every query the same connection; numbering is what lets a test tell a
 * statement run inside a transaction from one run beside it, which in production is a different
 * pooled connection.
 */
function numberedDialect(
  pg: PGlite,
  log: () => Logged[],
  failOn: () => ((sql: string) => Error | null) | null
): Dialect {
  const base = pgliteDialect(pg);
  let next = 0;
  return {
    createAdapter: () => base.createAdapter(),
    createIntrospector: (db) => base.createIntrospector(db),
    createQueryCompiler: () => base.createQueryCompiler(),
    createDriver: () => {
      const inner = base.createDriver();
      return {
        init: () => inner.init(),
        destroy: () => inner.destroy(),
        releaseConnection: (c) => inner.releaseConnection(c),
        beginTransaction: (c, s) => inner.beginTransaction(c, s),
        commitTransaction: (c) => inner.commitTransaction(c),
        rollbackTransaction: (c) => inner.rollbackTransaction(c),
        async acquireConnection() {
          const real = await inner.acquireConnection();
          const conn = ++next;
          const wrapped: DatabaseConnection = {
            async executeQuery(q) {
              log().push({ conn, sql: q.sql, params: q.parameters });
              const err = failOn()?.(q.sql);
              if (err) throw err;
              return real.executeQuery(q);
            },
            streamQuery: (q, n) => real.streamQuery(q, n),
          };
          return wrapped;
        },
      };
    },
  };
}

let mainPg: PGlite;
let modPg: PGlite;
let replica: Kysely<MainDB>;
let moderator: Kysely<ModeratorDB>;
let moderatorSql: Logged[];
let replicaSql: Logged[];
let replicaFailOn: ((sql: string) => Error | null) | null;

type Removal = { imageId: number | string; bucket: string; nsfw: string };
let removals: Removal[];
let scores: { id: number; score: number }[];
let chQueries: string[];

const REMOVED_AT = 1_790_000_000;
const DAY_MS = 24 * 3600 * 1000;

const clickhouse: ClickhouseQuery = async <T extends object>(query: string) => {
  chQueries.push(query);
  if (query.includes('FROM images'))
    return removals.map((r) => ({
      imageId: r.imageId,
      bucket: r.bucket,
      removedAt: REMOVED_AT,
      removedBy: 7,
      nsfw: r.nsfw,
    })) as unknown as T[];
  if (query.includes('FROM scanner_label_results'))
    return scores.map((s) => ({ ids: [String(s.id)], score: s.score })) as unknown as T[];
  throw new Error(`unexpected ClickHouse query: ${query}`);
};

const deps = () => ({ clickhouse, replica, moderator });

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
    deps()
  );

const itemIds = async () =>
  (await moderator.selectFrom('relabel_item').select('image_id').orderBy('image_id').execute()).map(
    (r) => r.image_id
  );

const item = (imageId: number) =>
  moderator
    .selectFrom('relabel_item')
    .selectAll()
    .where('image_id', '=', imageId)
    .executeTakeFirstOrThrow();

/** Removed images 1..n, one owner each (100 + id), all in one stratum so only the cap limits. */
async function seedRemovals(n: number) {
  await mainPg.query(
    `INSERT INTO "Image" (id, "userId", ingestion, "blockedFor")
     SELECT g, 100 + g, 'Blocked', 'moderated' FROM generate_series(1, $1::int) g`,
    [n]
  );
  removals = Array.from({ length: n }, (_, i) => ({
    imageId: i + 1,
    bucket: 'animatedMinorNsfw',
    nsfw: 'Soft',
  }));
}

/** Scanned, unremoved images 101..100+n, one owner each (1000 + id). */
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

async function seedItem(imageId: number, batch: string, relabel: boolean) {
  await moderator
    .insertInto('relabel_item')
    .values({
      batch,
      image_id: imageId,
      stratum: 'removed',
      bucket: 'animatedMinorNsfw',
      nsfw_level: 'Soft',
      stratum_key: 'animatedMinorNsfw:Soft',
      owner_id: 100 + imageId,
      relabel,
    })
    .execute();
}

// One instance per database for the file: PGlite takes seconds to boot.
beforeAll(async () => {
  mainPg = await PGlite.create();
  await mainPg.exec(MAIN_TABLES);
  modPg = await PGlite.create();
  await modPg.exec(MODERATOR_SCHEMA);
  replica = new Kysely<MainDB>({
    dialect: numberedDialect(
      mainPg,
      () => replicaSql,
      () => replicaFailOn
    ),
  });
  moderator = new Kysely<ModeratorDB>({
    dialect: numberedDialect(
      modPg,
      () => moderatorSql,
      () => null
    ),
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
  replicaSql = [];
  replicaFailOn = null;
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

  it('stores the removal, purge time, owner, stratum and latest appeal of a removed item', async () => {
    await seedRemovals(1);
    await mainPg.exec(`
      INSERT INTO "Appeal" ("entityId", "entityType", status, "createdAt")
      VALUES (1, 'Image', 'Rejected', '2026-09-01'), (1, 'Image', 'Pending', '2026-09-02')
    `);
    await build({ bands: null });
    const row = await item(1);
    expect(row).toMatchObject({
      stratum: 'removed',
      bucket: 'animatedMinorNsfw',
      nsfw_level: 'Soft',
      stratum_key: 'animatedMinorNsfw:Soft',
      owner_id: 101,
      removed_by: 7,
      appeal_status: 'Pending',
    });
    expect(row.removed_at?.getTime()).toBe(REMOVED_AT * 1000);
    expect(row.purge_after?.getTime()).toBe(REMOVED_AT * 1000 + 7 * DAY_MS);
  });

  it('stores a not-removed item with its current level, its band, and no purge time', async () => {
    await seedScanned(1, 0.7);
    await build({ bands: [0.5] });
    expect(await item(101)).toMatchObject({
      stratum: 'not_removed',
      bucket: null,
      nsfw_level: 'None',
      stratum_key: 'band1:None',
      owner_id: 1101,
      removed_at: null,
      purge_after: null,
    });
  });

  it('puts scores either side of an edge in different bands', async () => {
    await seedScanned(2);
    scores = [
      { id: 101, score: 0.3 },
      { id: 102, score: 0.7 },
    ];
    await build({ bands: [0.5] });
    expect((await item(101)).stratum_key).toBe('band0:None');
    expect((await item(102)).stratum_key).toBe('band1:None');
  });

  it('leaves out scanned images pending review, blocked, or not stills', async () => {
    await seedScanned(4);
    await mainPg.exec(`
      UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 101;
      UPDATE "Image" SET "blockedFor" = 'tos' WHERE id = 102;
      UPDATE "Image" SET type = 'video' WHERE id = 103;
    `);
    await build({ notRemoved: 10 });
    expect(await itemIds()).toEqual([104]);
  });

  it('reads first removals of the four buckets within the window, and scores within it', async () => {
    await seedRemovals(1);
    await seedScanned(1);
    await build({ days: 5 });
    const [removalsQuery, scoresQuery] = chQueries;
    expect(removalsQuery).toContain("type = 'DeleteTOS'");
    expect(removalsQuery).toContain('INTERVAL 5 DAY');
    expect(removalsQuery).toContain('argMin(violationType, time) AS bucket');
    expect(removalsQuery).toContain('min(time)) AS removedAt');
    expect(scoresQuery).toContain('INTERVAL 5 DAY');
    expect(scoresQuery).toContain('argMax(score, lastSeenAt)');
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
    await seedItem(1, '2026-10-03', true);
    const summary = await build({ bands: null });
    expect(summary.inserted).toBe(2);
    expect(await itemIds()).toHaveLength(3);
  });

  it("does not count another day's batch against today's cap", async () => {
    await seedRemovals(8);
    await build({ batch: '2026-10-02', bands: null });
    expect((await build({ bands: null })).inserted).toBe(3);
  });

  it("does not count today's model-only rows against the labeler cap", async () => {
    await seedRemovals(4);
    await seedItem(99, '2026-10-03', false);
    expect((await build({ bands: null })).inserted).toBe(3);
  });

  it('never re-picks an image labelers already have from another batch', async () => {
    await seedRemovals(4);
    await seedItem(1, '2026-10-01', true);
    const summary = await build({ removed: 4, bands: null });
    expect(summary.picked.removed).toBe(3);
    expect(summary.alreadyPresent).toBe(0);
    expect((await item(1)).batch).toBe('2026-10-01');
  });

  // On a pooled connection outside the transaction, `pg_advisory_xact_lock` is released when its
  // own statement ends and serialises nothing. PGlite cannot show two runs racing; this pins that
  // the lock is taken in the transaction that counts and writes the batch.
  it('takes the per-batch lock in the transaction that counts the batch', async () => {
    await seedRemovals(4);
    await build({ bands: null });
    const lock = moderatorSql.find((q) => q.sql.includes('pg_advisory_xact_lock'));
    const count = moderatorSql.find(
      (q) => q.sql.includes('count(*)') && q.sql.includes('relabel_item')
    );
    const begin = moderatorSql.find((q) => q.sql === 'begin');
    expect(begin).toBeDefined();
    expect(lock?.conn).toBe(begin?.conn);
    expect(count?.conn).toBe(begin?.conn);
    expect(moderatorSql.indexOf(lock!)).toBeLessThan(moderatorSql.indexOf(count!));
    expect(lock?.params).toEqual(['relabel-batch:2026-10-03']);
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

  it('excludes a CSAM-touched image past the first exclusion chunk', async () => {
    const n = CSAM_EXCLUSION_CHUNK + 10;
    const touched = CSAM_EXCLUSION_CHUNK + 5;
    await seedRemovals(n);
    await mainPg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [100 + touched]);
    const summary = await build({ removed: n, bands: null });
    expect(summary.csamExcluded.removed).toBe(1);
    expect(await itemIds()).toHaveLength(n - 1);
    expect(await itemIds()).not.toContain(touched);
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

  // A timeout set outside the exclusion's transaction would bound nothing, and an aborted caller
  // would leave the query running on the replica.
  it('bounds each exclusion query with a timeout in its own transaction', async () => {
    await seedRemovals(2);
    await build({ bands: null });
    const timeout = replicaSql.find((q) => q.sql.startsWith('SET LOCAL statement_timeout'));
    const exclusion = replicaSql.find((q) => q.sql.includes('"CsamReport"'));
    expect(timeout).toBeDefined();
    expect(exclusion?.conn).toBe(timeout?.conn);
    expect(replicaSql.some((q) => q.sql === 'begin' && q.conn === timeout?.conn)).toBe(true);
  });

  // Decision: a run whose exclusion cannot finish writes nothing at all, never a batch built
  // without it, and reports the skip rather than failing.
  it('writes nothing and reports a skip when the exclusion times out', async () => {
    await seedRemovals(3);
    replicaFailOn = (q) =>
      q.includes('"CsamReport"')
        ? Object.assign(new Error('canceling statement due to statement timeout'), {
            code: '57014',
          })
        : null;
    const summary = await build({ bands: null });
    expect(summary.skipped).toBe('csam exclusion timed out');
    expect(summary.inserted).toBe(0);
    expect(await itemIds()).toEqual([]);
  });

  it('fails on any other exclusion error', async () => {
    await seedRemovals(3);
    replicaFailOn = (q) =>
      q.includes('"CsamReport"') ? Object.assign(new Error('boom'), { code: 'XX000' }) : null;
    await expect(build({ bands: null })).rejects.toThrow('boom');
    expect(await itemIds()).toEqual([]);
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

describe('relabelBuildBatchAction', () => {
  const run = async (rawBands: string | undefined) => {
    const logged: Record<string, unknown>[] = [];
    const summary = await relabelBuildBatchAction(
      { batch: '2026-10-03', removed: 3, notRemoved: 2, days: 5, dryRun: false },
      rawBands,
      deps(),
      (d) => logged.push(d)
    );
    return { summary, logged };
  };

  it('builds the not-removed stratum from the env bands', async () => {
    await seedRemovals(2);
    await seedScanned(2);
    const { summary, logged } = await run('0.5');
    expect(summary.notRemovedSkipped).toBeNull();
    expect(summary.picked).toEqual({ removed: 2, notRemoved: 2 });
    expect(logged).toEqual([
      expect.objectContaining({ type: 'info', name: 'relabel-build-batch', inserted: 4 }),
    ]);
  });

  // Decision: the bands shape only the not-removed stratum, and removed items age out within days,
  // so a bad value must never cost the removed half. Never a single band either: that would sample
  // the stratum without the edges it is designed around.
  it('builds removed items only, and logs an error, when the env bands are malformed', async () => {
    await seedRemovals(2);
    await seedScanned(2);
    const { summary, logged } = await run('[0.2,0.5]');
    expect(summary.notRemovedSkipped).toBe('bands invalid');
    expect(summary.picked).toEqual({ removed: 2, notRemoved: 0 });
    expect(chQueries.some((q) => q.includes('scanner_label_results'))).toBe(false);
    expect(logged[0]).toMatchObject({ type: 'error', name: 'relabel-build-batch-bands-invalid' });
  });

  it('builds removed items only when the env bands are unset', async () => {
    await seedRemovals(2);
    await seedScanned(2);
    const { summary } = await run(undefined);
    expect(summary.notRemovedSkipped).toBe('bands unset');
    expect(summary.picked.notRemoved).toBe(0);
  });

  it('logs a skipped run as an error', async () => {
    await seedRemovals(2);
    replicaFailOn = (q) =>
      q.includes('"CsamReport"') ? Object.assign(new Error('timeout'), { code: '57014' }) : null;
    const { logged } = await run(undefined);
    expect(logged).toEqual([
      expect.objectContaining({ type: 'error', skipped: 'csam exclusion timed out' }),
    ]);
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
