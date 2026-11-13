import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getModelsWithVersionsStatsRow } from '@civitai/db-queries/hot-reads-11';
import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import {
  compiledRelations,
  declaredViews,
  isViewMarker,
  schemaLines,
} from '~/server/db/__tests__/no-view-ledger';
import {
  readModelsWithVersionsStatsViaKysely,
  readModelsWithVersionsStatsViaPrisma,
  type ModelsWithVersionsIds,
  type ModelsWithVersionsStats,
} from '~/server/services/hot-reads-11.reads';

/**
 * Parity gate for the reads behind `kysely-hot-reads-11`, the four per-page reads of
 * `getModelsWithVersions`. Both paths run against the same rows in the same database and must
 * return the same value, `toStrictEqual`, on the keys the caller reads (`ModelsWithVersionsStats`;
 * the Prisma metric reads have no `select`, so their rows also carry every other column, which the
 * shared type hides and the caller never reads). Prisma has no `orderBy`, so the metric and meta
 * lists are compared sorted by key; the linked components are ALSO compared in order, on rows
 * inserted in key order, because the caller keeps the last VAE row per version.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_11_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost. Locally, KYSELY_PARITY_DATABASE_URL
 * works too, and must point at a THROWAWAY database: the suite drops and recreates the
 * `hot_reads_11_parity` schema. It deliberately does NOT fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles the Kysely read and pins the one
 * statement it issues and the relations it names.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_11_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_11_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-11-parity-schema.sql'));

// ONE connection, so the search_path set in beforeAll holds for every Prisma statement.
const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  parsed.searchParams.set('connection_limit', '1');
  return parsed.toString();
};

// Ids pairwise distinct across tables, and none equal to a counter below.
const M_A = 11101; // metrics row, requested
const M_B = 11102; // no metrics row, requested
const M_C = 11103; // metrics row, NOT requested

const V_A1 = 11201; // version metrics, meta with values, two linked VAEs
const V_A2 = 11202; // no version metrics, empty meta, a "true" STRING flag (not linked)
const V_B1 = 11203; // version metrics, JSON-null meta, one linked text encoder among non-links
const V_OTHER = 11204; // every kind of row, NOT requested
const V_NO_ROW = 11205; // requested, no row anywhere

const IDS: ModelsWithVersionsIds = {
  modelIds: [M_A, M_B],
  modelVersionIds: [V_A1, V_A2, V_B1, V_NO_ROW],
};

const VAE_1 = { isLinkedComponent: true, componentType: 'VAE' };
const VAE_2 = { componentType: 'VAE', isLinkedComponent: true, note: 'second' };
const TEXT_ENCODER = { isLinkedComponent: true, componentType: 'TextEncoder' };

/** What both paths must return for IDS, written out: never derived from either reader. */
const EXPECTED: ModelsWithVersionsStats = {
  vaeLinkedRows: [
    { sourceId: V_A1, resourceId: 12151, settings: VAE_1 },
    { sourceId: V_A1, resourceId: 12152, settings: VAE_2 },
    { sourceId: V_B1, resourceId: 12156, settings: TEXT_ENCODER },
  ],
  metrics: [
    {
      modelId: M_A,
      downloadCount: 11501,
      thumbsUpCount: 11508,
      thumbsDownCount: 11509,
      commentCount: 11502,
      tippedAmountCount: 11506,
    },
  ],
  versionMetrics: [
    { modelVersionId: V_A1, downloadCount: 11801, thumbsUpCount: 11808, thumbsDownCount: 11809 },
    { modelVersionId: V_B1, downloadCount: 11901, thumbsUpCount: 11908, thumbsDownCount: 11909 },
  ],
  versionMetaRows: [
    { id: V_A1, meta: { hideDownloads: true, ratio: 1.25 } },
    { id: V_A2, meta: {} },
    { id: V_B1, meta: null },
  ],
};

// The keys the caller reads, written out (the narrow type, as a runtime list).
const MODEL_METRIC_KEYS = [
  'modelId',
  'downloadCount',
  'thumbsUpCount',
  'thumbsDownCount',
  'commentCount',
  'tippedAmountCount',
] as const;
const VERSION_METRIC_KEYS = [
  'modelVersionId',
  'downloadCount',
  'thumbsUpCount',
  'thumbsDownCount',
] as const;

const pick = <T extends object>(row: T, keys: readonly string[]) =>
  Object.fromEntries(keys.map((key) => [key, (row as Record<string, unknown>)[key]]));
const byNumber = <T>(rows: T[], key: (row: T) => number) =>
  [...rows].sort((a, b) => key(a) - key(b));

/** The caller's view of a result: read keys only, unordered lists sorted by key. */
function normalized(stats: ModelsWithVersionsStats) {
  return {
    vaeLinkedRows: stats.vaeLinkedRows.map((row) =>
      pick(row, ['sourceId', 'resourceId', 'settings'])
    ),
    metrics: byNumber(stats.metrics, (m) => m.modelId).map((m) => pick(m, MODEL_METRIC_KEYS)),
    versionMetrics: byNumber(stats.versionMetrics, (m) => m.modelVersionId).map((m) =>
      pick(m, VERSION_METRIC_KEYS)
    ),
    versionMetaRows: byNumber(stats.versionMetaRows, (v) => v.id).map((v) =>
      pick(v, ['id', 'meta'])
    ),
  };
}

describe.skipIf(!parityUrl)('hot reads 11: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({
    datasourceUrl: parityUrl && withSchema(parityUrl),
    log: [{ emit: 'event', level: 'query' }],
  });
  const prismaStatements: string[] = [];
  prisma.$on('query', (event) => {
    prismaStatements.push(event.query);
  });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;
  const exec = (statement: string) => prisma.$executeRawUnsafe(statement);

  // A logged client on its own pool, for the statement count.
  const pool = new Pool({ connectionString: parityUrl });
  const kyselyStatements: CompiledQuery[] = [];
  const logged = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    log: (event) => {
      if (event.level === 'query') kyselyStatements.push(event.query);
    },
  }).withSchema(SCHEMA);

  beforeAll(async () => {
    await exec(`SET search_path TO "${SCHEMA}", public`);
    for (const statement of schemaStatements) await exec(statement);
    await exec(`
      INSERT INTO ${t('ModelMetric')}
        ("modelId", "downloadCount", "commentCount", "collectedCount", "imageCount", "tippedCount",
         "tippedAmountCount", "generationCount", "thumbsUpCount", "thumbsDownCount", "earnedAmount",
         "updatedAt", poi, minor, "nsfwLevel", "userId", "lastVersionAt", "publishedAt", mode, status,
         availability, "hotScore", "uniqueGeneratorCount")
      VALUES
        (${M_A}, 11501, 11502, 11503, 11504, 11505, 11506, 11507, 11508, 11509, 11510,
         '2026-11-01 01:02:03.004', true, false, 28, 11601, '2026-10-01 01:02:03.004', NULL,
         'Archived', 'Published', 'EarlyAccess', 11511, 11512),
        (${M_C}, 11701, 11702, 11703, 11704, 11705, 11706, 11707, 11708, 11709, 11710,
         '2026-11-02 01:02:03.004', false, true, 1, 11602, NULL, NULL, NULL, 'Draft', 'Public', NULL, 0)
    `);
    await exec(`
      INSERT INTO ${t('ModelVersionMetric')}
        ("modelVersionId", "downloadCount", "commentCount", "collectedCount", "imageCount",
         "tippedCount", "tippedAmountCount", "generationCount", "thumbsUpCount", "thumbsDownCount",
         "earnedAmount", "updatedAt")
      VALUES
        (${V_A1}, 11801, 11802, 11803, 11804, 11805, 11806, 11807, 11808, 11809, 11810, '2026-11-03 01:02:03.004'),
        (${V_B1}, 11901, 11902, 11903, 11904, 11905, 11906, 11907, 11908, 11909, 11910, '2026-11-04 01:02:03.004'),
        (${V_OTHER}, 12001, 12002, 12003, 12004, 12005, 12006, 12007, 12008, 12009, 12010, '2026-11-05 01:02:03.004')
    `);
    await exec(`
      INSERT INTO ${t('ModelVersion')} (id, meta) VALUES
        (${V_A1}, '{"hideDownloads":true,"ratio":1.25}'),
        (${V_A2}, '{}'),
        (${V_B1}, 'null'),
        (${V_OTHER}, '{"other":1}')
    `);
    // In key order, so the heap order Prisma's unordered read follows is the key order.
    await exec(`
      INSERT INTO ${t('RecommendedResource')} (id, "sourceId", "resourceId", settings) VALUES
        (12101, ${V_A1}, 12151, '${JSON.stringify(VAE_1)}'),
        (12102, ${V_A1}, 12152, '${JSON.stringify(VAE_2)}'),
        (12103, ${V_A2}, 12153, '{"isLinkedComponent":"true","componentType":"VAE"}'),
        (12104, ${V_B1}, 12154, '{"isLinkedComponent":false,"componentType":"VAE"}'),
        (12105, ${V_B1}, 12155, NULL),
        (12106, ${V_B1}, 12156, '${JSON.stringify(TEXT_ENCODER)}'),
        (12107, ${V_OTHER}, 12157, '{"isLinkedComponent":true,"componentType":"VAE"}'),
        (12108, NULL, ${V_A1}, '{"isLinkedComponent":true}'),
        (12109, ${V_B1}, 12159, '{"nested":{"isLinkedComponent":true}}')
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
    await logged.destroy();
  });

  it('control: the Prisma reads return the expected rows', async () => {
    const result = await readModelsWithVersionsStatsViaPrisma(prisma, IDS);
    expect(normalized(result)).toStrictEqual(EXPECTED);
    // The metric reads have no select: their rows carry columns the caller never reads, which is
    // why the comparison is on the caller's keys.
    expect(Object.keys(result.metrics[0])).toContain('earnedAmount');
  });

  it('control: the Kysely read returns the expected rows, in key order, with only the read keys', async () => {
    const result = await readModelsWithVersionsStatsViaKysely(kysely, IDS);
    expect(result).toStrictEqual(EXPECTED);
  });

  it.each<[string, ModelsWithVersionsIds]>([
    ['a page with every relation', IDS],
    ['models with no versions', { modelIds: [M_A, M_B], modelVersionIds: [] }],
    ['versions only, one with nothing', { modelIds: [], modelVersionIds: [V_A2, V_NO_ROW] }],
    ['nothing requested', { modelIds: [], modelVersionIds: [] }],
    ['ids that match nothing', { modelIds: [M_B], modelVersionIds: [V_NO_ROW] }],
    ['repeated ids', { modelIds: [M_A, M_A], modelVersionIds: [V_A1, V_A1, V_B1] }],
  ])('%s: both paths agree', async (_, ids) => {
    const fromPrisma = await readModelsWithVersionsStatsViaPrisma(prisma, ids);
    const fromKysely = await readModelsWithVersionsStatsViaKysely(kysely, ids);
    expect(normalized(fromKysely)).toStrictEqual(normalized(fromPrisma));
    // The linked components in the order each path returned them: the caller keeps the last one.
    expect(fromKysely.vaeLinkedRows.map((row) => row.resourceId)).toStrictEqual(
      fromPrisma.vaeLinkedRows.map((row) => row.resourceId)
    );
  });

  it('control: the empty cases are empty, and repeated ids do not repeat rows', async () => {
    expect(
      await readModelsWithVersionsStatsViaKysely(kysely, { modelIds: [], modelVersionIds: [] })
    ).toStrictEqual({ vaeLinkedRows: [], metrics: [], versionMetrics: [], versionMetaRows: [] });
    const repeated = await readModelsWithVersionsStatsViaKysely(kysely, {
      modelIds: [M_A, M_A],
      modelVersionIds: [V_A1, V_A1, V_B1],
    });
    expect(repeated.metrics.map((m) => m.modelId)).toStrictEqual([M_A]);
    expect(repeated.versionMetrics.map((m) => m.modelVersionId)).toStrictEqual([V_A1, V_B1]);
    expect(repeated.vaeLinkedRows.map((row) => row.resourceId)).toStrictEqual([
      12151, 12152, 12156,
    ]);
  });

  it('one statement where Prisma issues four', async () => {
    prismaStatements.length = 0;
    await readModelsWithVersionsStatsViaPrisma(prisma, IDS);
    kyselyStatements.length = 0;
    await readModelsWithVersionsStatsViaKysely(logged, IDS);
    expect(kyselyStatements).toHaveLength(1);
    // Prisma's query events can lag the awaited read: wait for them, then count.
    await vi.waitFor(() => expect(prismaStatements.length).toBeGreaterThanOrEqual(4));
    await new Promise((done) => setTimeout(done, 50));
    expect(prismaStatements.length, prismaStatements.join('\n')).toBe(4);
  });

  it('no statement when nothing is requested', async () => {
    kyselyStatements.length = 0;
    await readModelsWithVersionsStatsViaKysely(logged, { modelIds: [], modelVersionIds: [] });
    expect(kyselyStatements).toHaveLength(0);
  });
});

// Offline: the statement is compiled, not run.

describe('hot reads 11: the one statement and the relations it reads', () => {
  it('control: the view list is read from the schema', () => {
    const views = declaredViews();
    for (const known of ['UserStat', 'ImageTag', 'TagsOnImageDetails'])
      expect(views.has(known), known).toBe(true);
    expect(views.markersAttributed).toBe(schemaLines().filter(isViewMarker).length);
  });

  it.each<[string, (db: never) => Promise<unknown>]>([
    ['the stats read', (db) => readModelsWithVersionsStatsViaKysely(db, IDS)],
    ['the row', (db) => getModelsWithVersionsStatsRow(db, IDS)],
  ])('%s', async (_, read) => {
    const relations = await compiledRelations(read);
    // An exact ledger: any extra relation or statement fails here.
    expect(relations).toEqual([
      ['ModelMetric', 'ModelVersion', 'ModelVersionMetric', 'RecommendedResource'],
    ]);
    const views = declaredViews();
    expect(relations.flat().filter((r) => views.has(r))).toEqual([]);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
