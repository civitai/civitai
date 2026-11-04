import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import { readTaggedGolden } from '~/server/db/__tests__/tagged-golden';
import {
  compiledRelations,
  declaredViews,
  isViewMarker,
  relationsOf,
  schemaLines,
} from '~/server/db/__tests__/no-view-ledger';
import {
  countSuggestedResourcesViaKysely,
  readDefaultModelVersionsViaKysely,
  readModelPagePostsViaKysely,
  readOwnerSettingsViaKysely,
  readViewerPendingPlacementsViaKysely,
  type DefaultModelVersionInput,
  type ModelPagePostsInput,
  type ViewerPendingPlacementsInput,
} from '~/server/services/hot-reads-3.reads';

/**
 * The Kysely reads that replaced the Prisma ones behind the retired hot-reads-3 flag: the model
 * page's default-version lookup, the suggested-resource count, the owner's settings, the owner's
 * posts on the versions, and the viewer's pending remix-gallery submissions. Each must return,
 * `toStrictEqual`, the value the Prisma read returned for the same rows: timestamps as UTC Dates,
 * enums as strings, JSON decoded, NULL as `null`, a missing row as `null`, counts as numbers, and
 * rows in the same order (every Prisma read here was ordered, and every fixture below keeps the
 * order key distinct so no case compares a tie).
 *
 * Those values are fixtures/hot-reads-3-golden.json, printed by the Prisma readers the services ran
 * (hot-reads-3.reads.ts) against these same fixture rows in CI, before they were deleted. A change to
 * the fixture rows needs the golden re-derived by hand.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_3_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost, so the suite cannot skip itself
 * there unnoticed. Locally, KYSELY_PARITY_DATABASE_URL works too, and must point at a THROWAWAY
 * database: the suite drops and recreates the `hot_reads_3_parity` schema. It deliberately does NOT
 * fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles every statement the Kysely readers
 * issue and checks the relations they name against `schema.full.prisma`, so none of them reads a
 * VIEW (an aggregate view joined or filtered on a non-key column is computed in full).
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_3_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_3_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-3-parity-schema.sql'));

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

// Distinct ids per table, and none equal to a count, an index or another id.
const OWNER = 1301;
const NULL_SETTINGS = 1302;
const OTHER_USER = 1303;
const MISSING_USER = 1399;
const MODEL = 3301;
const MODEL_EMPTY = 3302;
const MODEL_MANY = 3303;
const MISSING_MODEL = 3399;
const V_PUBLISHED = 4301;
const V_TRAINING = 4302;
const V_UNINDEXED = 4303;
const V_SCHEDULED = 4304;
const V_MANY_FIRST = 4401; // 4401..4411 belong to MODEL_MANY
const HOST = 5301;
const OTHER_HOST = 5302;
const PL_NEWEST = 6301;
const PL_OLDEST = 6302;
const PL_MIDDLE = 6303;
const SUGGESTED_COUNT = 3;

const golden = readTaggedGolden(resolve(here, 'fixtures/hot-reads-3-golden.json'));

describe.skipIf(!parityUrl)('hot reads 3: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl && withSchema(parityUrl) });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;

  beforeAll(async () => {
    for (const statement of schemaStatements) await prisma.$executeRawUnsafe(statement);

    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('User')} (id, settings) VALUES
        (${OWNER}, '{"metricPrivacy": {"downloads": true}, "nested": [1, "two", null]}'),
        (${NULL_SETTINGS}, NULL),
        (${OTHER_USER}, '{}')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Model')} (id, "userId", status, availability) VALUES
        (${MODEL}, ${OWNER}, 'Published', 'EarlyAccess'),
        (${MODEL_EMPTY}, ${OTHER_USER}, 'Draft', 'Private'),
        (${MODEL_MANY}, ${OWNER}, 'Scheduled', 'Public')
    `);
    // Indices out of id order, so `index asc` and `id asc` disagree, and one NULL index (last).
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelVersion')} (id, index, "modelId", "publishedAt", status,
        "trainingStatus", availability) VALUES
        (${V_PUBLISHED}, 2, ${MODEL}, '2026-04-01 01:02:03.456', 'Published', NULL, 'Public'),
        (${V_TRAINING}, 0, ${MODEL}, NULL, 'Draft', 'Processing', 'Private'),
        (${V_UNINDEXED}, NULL, ${MODEL}, '2026-05-02 03:04:05.678', 'Published', 'Approved',
          'EarlyAccess'),
        (${V_SCHEDULED}, 1, ${MODEL}, '2099-01-01 00:00:00.001', 'Scheduled', NULL, 'Unsearchable')
    `);
    // Eleven versions, indices descending by id, so the ten-row cap and the order both show.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelVersion')} (id, index, "modelId", "publishedAt", status, availability)
      SELECT ${V_MANY_FIRST} + n, 20 - n, ${MODEL_MANY},
        TIMESTAMP '2026-01-01 00:00:00.000' + n * INTERVAL '1 day', 'Published', 'Public'
      FROM generate_series(0, 10) AS n
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelAssociations')} (id, "fromModelId", "toModelId", type) VALUES
        (7301, ${MODEL}, ${MODEL_EMPTY}, 'Suggested'),
        (7302, ${MODEL}, ${MODEL_MANY}, 'Suggested'),
        (7303, ${MODEL}, NULL, 'Suggested'),
        (7304, ${MODEL_MANY}, ${MODEL}, 'Suggested')
    `);
    // Ids out of insertion order, another user's post on an owner version, a post on no version.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Post')} (id, "userId", "modelVersionId") VALUES
        (8305, ${OWNER}, ${V_PUBLISHED}),
        (8301, ${OWNER}, ${V_TRAINING}),
        (8303, ${OWNER}, ${V_PUBLISHED}),
        (8302, ${OTHER_USER}, ${V_PUBLISHED}),
        (8304, ${OWNER}, NULL)
    `);
    // createdAt out of id order. Excluded rows: approved, someone else's, another target, another
    // surface, another target type.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Placement')} (id, surface, "targetType", "targetId", "ownerId", "placerId",
        data, status, amount, free, "createdAt", "expiresAt") VALUES
        (${PL_NEWEST}, 'remixGallery', 'image', ${HOST}, ${OTHER_USER}, ${OWNER},
          '{"imageId": 91, "note": "newest"}', 'pending', 0, true, '2026-06-03 00:00:00.003', NULL),
        (${PL_OLDEST}, 'remixGallery', 'image', ${HOST}, ${OTHER_USER}, ${OWNER},
          '{"imageId": 92}', 'pending', 125, false, '2026-06-01 00:00:00.001',
          '2026-06-03 00:00:00.001'),
        (${PL_MIDDLE}, 'remixGallery', 'image', ${HOST}, ${OTHER_USER}, ${OWNER},
          '{"imageId": 93, "list": [1, 2]}', 'pending', 40, false, '2026-06-02 00:00:00.002',
          '2026-06-04 00:00:00.002'),
        (6304, 'remixGallery', 'image', ${HOST}, ${OTHER_USER}, ${OWNER}, '{"imageId": 94}',
          'approved', 41, false, '2026-05-30 00:00:00.000', NULL),
        (6305, 'remixGallery', 'image', ${HOST}, ${OWNER}, ${OTHER_USER}, '{"imageId": 95}',
          'pending', 42, false, '2026-05-29 00:00:00.000', NULL),
        (6306, 'remixGallery', 'image', ${OTHER_HOST}, ${OTHER_USER}, ${OWNER}, '{"imageId": 96}',
          'pending', 43, false, '2026-05-28 00:00:00.000', NULL),
        (6307, 'sticker', 'image', ${HOST}, ${OTHER_USER}, ${OWNER}, '{"imageId": 97}',
          'pending', 44, false, '2026-05-27 00:00:00.000', NULL),
        (6308, 'remixGallery', 'post', ${HOST}, ${OTHER_USER}, ${OWNER}, '{"imageId": 98}',
          'pending', 45, false, '2026-05-26 00:00:00.000', NULL)
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
  });

  describe('the default-version lookup', () => {
    it.each<[string, DefaultModelVersionInput]>([
      ['a model with several versions, in index order', { modelId: MODEL }],
      ['narrowed to one version', { modelId: MODEL, modelVersionId: V_TRAINING }],
      ['narrowed to the NULL-index version', { modelId: MODEL, modelVersionId: V_UNINDEXED }],
      [
        'narrowed to another model`s version (no match)',
        { modelId: MODEL, modelVersionId: V_MANY_FIRST },
      ],
      ['a version id of 0 is no filter', { modelId: MODEL, modelVersionId: 0 }],
      ['more than ten versions (capped at ten)', { modelId: MODEL_MANY }],
      ['a model with no versions', { modelId: MODEL_EMPTY }],
      ['a missing model', { modelId: MISSING_MODEL }],
    ])('%s', async (_, input) => {
      const viaKysely = await readDefaultModelVersionsViaKysely(kysely, input);
      expect(viaKysely).toStrictEqual(golden.take(`default-version:${_}`));
    });

    it('control: the fixtures exercise order, NULLs, the cap and the empty cases', async () => {
      const full = await readDefaultModelVersionsViaKysely(kysely, { modelId: MODEL });
      expect(full?.modelVersions.map((v) => v.id)).toEqual([
        V_TRAINING,
        V_SCHEDULED,
        V_PUBLISHED,
        V_UNINDEXED,
      ]);
      expect(full?.modelVersions[0]).toStrictEqual({
        id: V_TRAINING,
        status: 'Draft',
        publishedAt: null,
        model: { id: MODEL, userId: OWNER, availability: 'EarlyAccess', status: 'Published' },
        availability: 'Private',
        trainingStatus: 'Processing',
      });
      expect(full?.modelVersions[2].publishedAt).toEqual(new Date('2026-04-01T01:02:03.456Z'));
      const many = await readDefaultModelVersionsViaKysely(kysely, { modelId: MODEL_MANY });
      expect(many?.modelVersions.map((v) => v.id)).toEqual(
        Array.from({ length: 10 }, (_, i) => V_MANY_FIRST + 10 - i)
      );
      expect(
        await readDefaultModelVersionsViaKysely(kysely, { modelId: MODEL_EMPTY })
      ).toStrictEqual({ modelVersions: [] });
      expect(
        await readDefaultModelVersionsViaKysely(kysely, { modelId: MISSING_MODEL })
      ).toBeNull();
    });
  });

  describe('the suggested-resource count', () => {
    it.each([
      ['a model with suggestions', MODEL],
      ['a model with none', MODEL_EMPTY],
      ['a missing model', MISSING_MODEL],
    ])('%s', async (_, modelId) => {
      const viaKysely = await countSuggestedResourcesViaKysely(kysely, modelId);
      expect(viaKysely).toStrictEqual(golden.take(`suggested:${_}`));
    });

    it('control: the fixture count is the one expected, as a number', async () => {
      expect(await countSuggestedResourcesViaKysely(kysely, MODEL)).toBe(SUGGESTED_COUNT);
    });
  });

  describe("the owner's settings", () => {
    it.each([
      ['JSON settings', OWNER],
      ['NULL settings', NULL_SETTINGS],
      ['empty settings', OTHER_USER],
      ['a missing user', MISSING_USER],
    ])('%s', async (_, userId) => {
      const viaKysely = await readOwnerSettingsViaKysely(kysely, userId);
      expect(viaKysely).toStrictEqual(golden.take(`settings:${_}`));
    });

    it('control: the JSON fixture decodes', async () => {
      expect(await readOwnerSettingsViaKysely(kysely, OWNER)).toStrictEqual({
        metricPrivacy: { downloads: true },
        nested: [1, 'two', null],
      });
    });
  });

  describe("the owner's posts on the versions", () => {
    it.each<[string, ModelPagePostsInput]>([
      ['two versions', { modelVersionIds: [V_PUBLISHED, V_TRAINING], userId: OWNER }],
      ['a version with no posts', { modelVersionIds: [V_UNINDEXED], userId: OWNER }],
      ['no versions', { modelVersionIds: [], userId: OWNER }],
      ['another user', { modelVersionIds: [V_PUBLISHED, V_TRAINING], userId: OTHER_USER }],
    ])('%s', async (_, input) => {
      const viaKysely = await readModelPagePostsViaKysely(kysely, input);
      expect(viaKysely).toStrictEqual(golden.take(`posts:${_}`));
    });

    it('control: the fixture posts come back in id order', async () => {
      const posts = await readModelPagePostsViaKysely(kysely, {
        modelVersionIds: [V_PUBLISHED, V_TRAINING],
        userId: OWNER,
      });
      expect(posts).toStrictEqual([
        { id: 8301, modelVersionId: V_TRAINING },
        { id: 8303, modelVersionId: V_PUBLISHED },
        { id: 8305, modelVersionId: V_PUBLISHED },
      ]);
    });
  });

  describe("the viewer's pending remix submissions", () => {
    const input = (overrides: Partial<ViewerPendingPlacementsInput> = {}) => ({
      surface: 'remixGallery',
      targetType: 'image',
      targetId: HOST,
      placerId: OWNER,
      limit: 25,
      ...overrides,
    });

    it.each<[string, ViewerPendingPlacementsInput]>([
      ['the viewer`s pending rows, oldest first', input()],
      ['capped by the limit', input({ limit: 2 })],
      ['another placer', input({ placerId: OTHER_USER })],
      ['another target', input({ targetId: OTHER_HOST })],
      ['nothing pending', input({ targetId: MISSING_MODEL })],
    ])('%s', async (_, args) => {
      const viaKysely = await readViewerPendingPlacementsViaKysely(kysely, args);
      expect(viaKysely).toStrictEqual(golden.take(`pending:${_}`));
    });

    it('control: the fixture rows exercise order, the filters, free and a NULL expiry', async () => {
      const rows = await readViewerPendingPlacementsViaKysely(kysely, input());
      expect(rows.map((row) => row.id)).toEqual([PL_OLDEST, PL_MIDDLE, PL_NEWEST]);
      expect(rows[2]).toStrictEqual({
        id: PL_NEWEST,
        amount: 0,
        free: true,
        data: { imageId: 91, note: 'newest' },
        createdAt: new Date('2026-06-03T00:00:00.003Z'),
        expiresAt: null,
      });
    });
  });

  // Last in the block: every captured case is still asserted above, so none can be dropped quietly.
  it('every golden case is asserted', () => {
    expect(golden.unused()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// No statement reads a VIEW. Offline: the statements are compiled, not run.

describe('hot reads 3: no statement reads a view', () => {
  it('control: the view list is read from the schema, and names the known aggregate views', () => {
    const views = declaredViews();
    for (const known of ['UserStat', 'ModelReportStat', 'GenerationCoverage', 'ImageTag'])
      expect(views.has(known), known).toBe(true);
    for (const table of ['Model', 'ModelVersion', 'ModelAssociations', 'User', 'Post', 'Placement'])
      expect(views.has(table), table).toBe(false);
    // Every marker line in the file is attributed to a model, so none is missed. (Counted by marker
    // line, not by view: a model may carry the marker twice.)
    expect(views.markersAttributed).toBe(schemaLines().filter(isViewMarker).length);
  });

  it('control: the relation extractor finds a view a statement reads', () => {
    expect(relationsOf('select * from "UserStat" inner join "User" on 1 = 1')).toEqual([
      'User',
      'UserStat',
    ]);
  });

  it.each<[string, (db: never) => Promise<unknown>, string[][]]>([
    [
      'the default-version lookup (one statement)',
      (db) => readDefaultModelVersionsViaKysely(db, { modelId: 1, modelVersionId: 2 }),
      [['Model', 'ModelVersion']],
    ],
    [
      'the suggested-resource count',
      (db) => countSuggestedResourcesViaKysely(db, 1),
      [['ModelAssociations']],
    ],
    ["the owner's settings", (db) => readOwnerSettingsViaKysely(db, 1), [['User']]],
    [
      "the owner's posts",
      (db) => readModelPagePostsViaKysely(db, { modelVersionIds: [1], userId: 2 }),
      [['Post']],
    ],
    [
      "the viewer's pending remix submissions",
      (db) =>
        readViewerPendingPlacementsViaKysely(db, {
          surface: 's',
          targetType: 't',
          targetId: 1,
          placerId: 2,
          limit: 3,
        }),
      [['Placement']],
    ],
  ])('%s', async (_, read, expected) => {
    const relations = await compiledRelations(read);
    // An exact ledger: a joined view, or any extra relation, fails here.
    expect(relations).toEqual(expected);
    const views = declaredViews();
    for (const relation of relations.flat()) expect(views.has(relation), relation).toBe(false);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
