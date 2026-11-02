import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import {
  compiledRelations,
  declaredViews,
  isViewMarker,
  relationsOf,
  schemaLines,
} from '~/server/db/__tests__/no-view-ledger';
import {
  readHeldItemCountsViaKysely,
  readHeldItemCountsViaPrisma,
  readPostModelVersionIdsViaKysely,
  readPostModelVersionIdsViaPrisma,
  readSfwModelNamesViaKysely,
  readSfwModelNamesViaPrisma,
  type HeldItemCountsInput,
} from '~/server/services/hot-reads-7.reads';

/**
 * Parity gate for the reads behind `kysely-hot-reads-7`. Both paths run against the same rows in
 * the same database and must return the same value, `toStrictEqual`. Every read here is unordered
 * on both sides (no `orderBy`), so lists and Map entries are compared sorted.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_7_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost. Locally, KYSELY_PARITY_DATABASE_URL
 * works too, and must point at a THROWAWAY database: the suite drops and recreates the
 * `hot_reads_7_parity` schema. It deliberately does NOT fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles every statement the Kysely readers
 * issue and checks the relations they name against `schema.full.prisma`, so none of them reads a
 * VIEW.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_7_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_7_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-7-parity-schema.sql'));

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

// Distinct ids per table, and none equal to a count or another table's id.
const P_A = 7601; // on version A
const P_B = 7602; // on version B
const P_PLAIN = 7603; // on version A
const P_NO_VERSION = 7604; // on no version
const P_GONE = 7699; // no post row
const P_MISSING = 7698; // no post row

const MV_A = 7301;
const MV_B = 7302;

const M_FACE = 7201;
const M_NO_FACE = 7202;
const M_EMPTY_FACE = 7203;
const M_FACE_2 = 7204;
const M_GONE = 7299;

const HOLDER = 7101;
const OTHER_HOLDER = 7102;
const NO_ITEMS = 7103;

const D_BOX_PUBLISHED = 7801;
const D_BOX_ARCHIVED = 7802;
const D_BOX_DRAFT = 7803;
const D_COSMETIC = 7804;
const D_BOX_UNHELD = 7805;

const SHOWN = ['published', 'archived'];

const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);
const entries = <K extends number, V>(map: Map<K, V>) =>
  [...map.entries()].sort(([a], [b]) => a - b);

describe.skipIf(!parityUrl)('hot reads 7: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl && withSchema(parityUrl) });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;
  const exec = (statement: string) => prisma.$executeRawUnsafe(statement);

  beforeAll(async () => {
    for (const statement of schemaStatements) await exec(statement);
    await exec(`
      INSERT INTO ${t('Post')} (id, "modelVersionId") VALUES
        (${P_A}, ${MV_A}), (${P_B}, ${MV_B}), (${P_PLAIN}, ${MV_A}),
        (${P_NO_VERSION}, NULL)
    `);
    await exec(`
      INSERT INTO ${t('Model')} (id, "sfwName") VALUES
        (${M_FACE}, 'Face title'), (${M_NO_FACE}, NULL), (${M_EMPTY_FACE}, ''),
        (${M_FACE_2}, 'Second face')
    `);
    await exec(`
      INSERT INTO ${t('ItemDefinition')} (id, type, status) VALUES
        (${D_BOX_PUBLISHED}, 'box', 'published'), (${D_BOX_ARCHIVED}, 'box', 'archived'),
        (${D_BOX_DRAFT}, 'box', 'draft'), (${D_COSMETIC}, 'cosmetic', 'published'),
        (${D_BOX_UNHELD}, 'box', 'published')
    `);
    // Quantities differ from 1, so a read summing `quantity` instead of counting rows differs.
    await exec(`
      INSERT INTO ${t('Item')} (id, "itemDefinitionId", "holderType", "holderId", quantity) VALUES
        (1, ${D_BOX_PUBLISHED}, 'user', ${HOLDER}, 5),
        (2, ${D_BOX_PUBLISHED}, 'user', ${HOLDER}, 1),
        (3, ${D_BOX_PUBLISHED}, 'user', ${HOLDER}, 1),
        (4, ${D_BOX_ARCHIVED}, 'user', ${HOLDER}, 9),
        (5, ${D_BOX_DRAFT}, 'user', ${HOLDER}, 1),
        (6, ${D_COSMETIC}, 'user', ${HOLDER}, 1),
        (7, ${D_BOX_PUBLISHED}, 'faction', ${HOLDER}, 1),
        (8, ${D_BOX_ARCHIVED}, 'user', ${OTHER_HOLDER}, 1),
        (9, 7899, 'user', ${HOLDER}, 1)
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
  });

  describe("a set of models' .com titles", () => {
    it.each([
      [
        'with and without a title, an empty title and a missing model',
        [M_FACE, M_NO_FACE, M_EMPTY_FACE, M_GONE],
      ],
      ['two titled models', [M_FACE_2, M_FACE]],
      ['no titled model', [M_NO_FACE, M_GONE]],
      ['no models', []],
    ])('%s', async (_, ids) => {
      expect(entries(await readSfwModelNamesViaKysely(kysely, ids))).toStrictEqual(
        entries(await readSfwModelNamesViaPrisma(prisma, ids))
      );
    });

    it('control: each branch reads the fixture expected', async () => {
      expect(
        entries(await readSfwModelNamesViaKysely(kysely, [M_FACE, M_NO_FACE, M_EMPTY_FACE, M_GONE]))
      ).toStrictEqual([
        [M_FACE, 'Face title'],
        [M_EMPTY_FACE, ''],
      ]);
      expect((await readSfwModelNamesViaKysely(kysely, [M_NO_FACE])).size).toBe(0);
    });
  });

  describe("a set of posts' model versions", () => {
    it.each([
      ['on a version, on none, and missing', [P_PLAIN, P_NO_VERSION, P_MISSING]],
      ['several on versions', [P_B, P_A, P_PLAIN]],
      ['missing only', [P_MISSING, P_GONE]],
      ['no posts', []],
    ])('%s', async (_, ids) => {
      expect(byId(await readPostModelVersionIdsViaKysely(kysely, ids))).toStrictEqual(
        byId(await readPostModelVersionIdsViaPrisma(prisma, ids))
      );
    });

    it('control: each branch reads the fixture expected', async () => {
      expect(
        byId(await readPostModelVersionIdsViaKysely(kysely, [P_PLAIN, P_NO_VERSION, P_MISSING]))
      ).toStrictEqual([
        { id: P_PLAIN, modelVersionId: MV_A },
        { id: P_NO_VERSION, modelVersionId: null },
      ]);
    });
  });

  describe("a user's held items counted by definition", () => {
    it.each<[string, HeldItemCountsInput]>([
      ['shown boxes', { userId: HOLDER, type: 'box', statuses: SHOWN }],
      ['published boxes only', { userId: HOLDER, type: 'box', statuses: ['published'] }],
      ['draft boxes', { userId: HOLDER, type: 'box', statuses: ['draft'] }],
      ['cosmetics', { userId: HOLDER, type: 'cosmetic', statuses: SHOWN }],
      ['another holder', { userId: OTHER_HOLDER, type: 'box', statuses: SHOWN }],
      ['a holder with no items', { userId: NO_ITEMS, type: 'box', statuses: SHOWN }],
      ['no statuses', { userId: HOLDER, type: 'box', statuses: [] }],
    ])('%s', async (_, input) => {
      expect(entries(await readHeldItemCountsViaKysely(kysely, input))).toStrictEqual(
        entries(await readHeldItemCountsViaPrisma(prisma, input))
      );
    });

    it('control: each branch reads the fixture expected', async () => {
      // Rows, not quantity; the faction-held row, the draft, the cosmetic and the item of a
      // definition that is gone are left out.
      expect(
        entries(
          await readHeldItemCountsViaKysely(kysely, {
            userId: HOLDER,
            type: 'box',
            statuses: SHOWN,
          })
        )
      ).toStrictEqual([
        [D_BOX_PUBLISHED, 3],
        [D_BOX_ARCHIVED, 1],
      ]);
      expect(
        entries(
          await readHeldItemCountsViaKysely(kysely, {
            userId: OTHER_HOLDER,
            type: 'box',
            statuses: SHOWN,
          })
        )
      ).toStrictEqual([[D_BOX_ARCHIVED, 1]]);
    });
  });
});

// No statement reads a VIEW. Offline: the statements are compiled, not run.

describe('hot reads 7: no statement reads a view', () => {
  const TABLES = ['Model', 'Post', 'Item', 'ItemDefinition'];

  it('control: the view list is read from the schema, and names the known aggregate views', () => {
    const views = declaredViews();
    for (const known of ['UserStat', 'ModelReportStat', 'GenerationCoverage', 'ImageTag'])
      expect(views.has(known), known).toBe(true);
    for (const table of TABLES) expect(views.has(table), table).toBe(false);
    expect(views.markersAttributed).toBe(schemaLines().filter(isViewMarker).length);
  });

  it('control: the relation extractor finds a view a statement reads', () => {
    expect(relationsOf('select * from "UserStat" inner join "User" on 1 = 1')).toEqual([
      'User',
      'UserStat',
    ]);
  });

  it.each<[string, (db: never) => Promise<unknown>, string[][]]>([
    ['.com titles', (db) => readSfwModelNamesViaKysely(db, [1]), [['Model']]],
    ["posts' model versions", (db) => readPostModelVersionIdsViaKysely(db, [1]), [['Post']]],
    [
      'held item counts',
      (db) => readHeldItemCountsViaKysely(db, { userId: 1, type: 'box', statuses: ['published'] }),
      [['Item', 'ItemDefinition']],
    ],
    // An empty list issues no statement.
    ['an empty id list', (db) => readSfwModelNamesViaKysely(db, []), []],
  ])('%s', async (_, read, expected) => {
    const relations = await compiledRelations(read);
    // An exact ledger: a joined view, or any extra relation or statement, fails here.
    expect(relations).toEqual(expected);
    const views = declaredViews();
    for (const relation of relations.flat()) expect(views.has(relation), relation).toBe(false);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
