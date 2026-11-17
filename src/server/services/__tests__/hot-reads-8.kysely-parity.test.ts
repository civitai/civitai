import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  getModelVersionWithOwner,
  getUserIdIfExists,
  listStorylinePostsWithAuthor,
  listStorylineRootChapters,
  listStorylinesWithOwner,
  listUserCosmeticsWithCosmetic,
} from '@civitai/db-queries/hot-reads-8';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import {
  compiledRelations,
  declaredViews,
  isViewMarker,
  relationsOf,
  schemaLines,
} from '~/server/db/__tests__/no-view-ledger';
import { simpleCosmeticSelect } from '~/server/selectors/cosmetic.selector';
import {
  readDonationGoalVersionViaKysely,
  readDonationGoalVersionViaPrisma,
  readStorylineChaptersForPostsViaKysely,
  readStorylineChaptersForPostsViaPrisma,
  readUserCosmeticsViaKysely,
  readUserCosmeticsViaPrisma,
  USER_COSMETIC_COSMETIC_FIELDS,
  type UserCosmeticsInput,
} from '~/server/services/hot-reads-8.reads';

/**
 * Parity gate for the reads behind `kysely-hot-reads-8`. Both paths run against the same rows in
 * the same database and must return the same value, `toStrictEqual`. None of these reads has an
 * `orderBy` on the Prisma side, so lists are compared sorted; the Kysely cosmetics read's own
 * order (primary key) is pinned by a literal control.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_8_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost. Locally, KYSELY_PARITY_DATABASE_URL
 * works too, and must point at a THROWAWAY database: the suite drops and recreates the
 * `hot_reads_8_parity` schema. It deliberately does NOT fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles every statement the Kysely readers
 * issue and checks the relations they name against `schema.full.prisma`, so none of them reads a
 * VIEW, and it pins the cosmetic field list against the shared selector.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_8_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_8_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-8-parity-schema.sql'));

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

// Distinct ids per table, and none equal to a level, a depth, a flag or another table's id.
const U_AUTHOR = 8101;
const U_OWNER = 8102;
const U_BANNED = 8103;
const U_DELETED = 8104;
const U_COLLECTOR = 8105;
const U_NO_COSMETICS = 8106;
const U_GONE = 8199;

const P_ROOT_A = 8601; // story A's first chapter
const P_A_1 = 8602; // story A, depth 1, banned author, taken down
const P_A_2 = 8603; // story A, depth 2, removed
const P_ROOT_B = 8604; // story B's first chapter, deleted author, unpublished
const P_C_1 = 8605; // story C, whose first chapter lost its post
const P_D_1 = 8606; // story D, which has no first chapter
const P_PLAIN = 8607; // no chapter
const P_MISSING = 8698; // no post row

const S_A = 8401;
const S_B = 8402; // banned owner, rated title, minor-by-scan, taken down
const S_C = 8403;
const S_D = 8404;

const C_ROOT_A = 8501;
const C_A_1 = 8502;
const C_A_2 = 8503;
const C_ROOT_B = 8504;
const C_ROOT_C = 8505; // post deleted, so postId is NULL
const C_C_1 = 8506;
const C_D_1 = 8507;

const CO_BADGE = 8701;
const CO_DECORATION = 8702;
const CO_PLATE = 8703;

const M_A = 8201;
const M_B = 8202;
const MV_A = 8301;
const MV_B = 8302;
const MV_GONE = 8399;

const BANNED_AT = new Date('2026-03-04T05:06:07.089Z');
const DELETED_AT = new Date('2026-04-05T06:07:08.091Z');
const REMOVED_AT = new Date('2026-05-06T07:08:09.012Z');
const PUBLISHED_AT = new Date('2026-06-07T08:09:10.123Z');
const OBTAINED_AT = new Date('2026-07-08T09:10:11.234Z');
const EQUIPPED_AT = new Date('2026-08-09T10:11:12.345Z');

const ts = (date: Date) => `'${date.toISOString().replace('T', ' ').replace('Z', '')}'`;

const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);
type CosmeticRow = { claimKey: string; cosmetic: { id: number } };
const byKey = <T extends CosmeticRow>(rows: T[]) =>
  [...rows].sort((a, b) => a.cosmetic.id - b.cosmetic.id || a.claimKey.localeCompare(b.claimKey));
const sortedCosmetics = <T extends { cosmetics: CosmeticRow[] } | null>(value: T) =>
  value && { ...value, cosmetics: byKey(value.cosmetics) };

describe.skipIf(!parityUrl)('hot reads 8: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl && withSchema(parityUrl) });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;
  const exec = (statement: string) => prisma.$executeRawUnsafe(statement);

  beforeAll(async () => {
    for (const statement of schemaStatements) await exec(statement);
    await exec(`
      INSERT INTO ${t('User')} (id, "bannedAt", "deletedAt") VALUES
        (${U_AUTHOR}, NULL, NULL), (${U_OWNER}, NULL, NULL),
        (${U_BANNED}, ${ts(BANNED_AT)}, NULL), (${U_DELETED}, NULL, ${ts(DELETED_AT)}),
        (${U_COLLECTOR}, NULL, NULL), (${U_NO_COSMETICS}, NULL, NULL)
    `);
    await exec(`
      INSERT INTO ${t('Post')} (id, "userId", "nsfwLevel", "tosViolation", "publishedAt") VALUES
        (${P_ROOT_A}, ${U_AUTHOR}, 1, false, ${ts(PUBLISHED_AT)}),
        (${P_A_1}, ${U_BANNED}, 4, true, ${ts(PUBLISHED_AT)}),
        (${P_A_2}, ${U_AUTHOR}, 8, false, ${ts(PUBLISHED_AT)}),
        (${P_ROOT_B}, ${U_DELETED}, 2, false, NULL),
        (${P_C_1}, ${U_AUTHOR}, 16, false, ${ts(PUBLISHED_AT)}),
        (${P_D_1}, ${U_OWNER}, 0, false, ${ts(PUBLISHED_AT)}),
        (${P_PLAIN}, ${U_AUTHOR}, 1, false, ${ts(PUBLISHED_AT)})
    `);
    await exec(`
      INSERT INTO ${t('Storyline')}
        (id, "userId", title, "maxNsfwLevel", "tosViolation", "minorByScan", "nsfwLevel", "moderatorNsfwLevel")
      VALUES
        (${S_A}, ${U_OWNER}, 'Story A', 31, false, false, 0, NULL),
        (${S_B}, ${U_BANNED}, 'Story B', 15, true, true, 4, 8),
        (${S_C}, ${U_OWNER}, 'Story C', 7, false, false, 1, NULL),
        (${S_D}, ${U_AUTHOR}, 'Story D', 3, false, false, 0, 2)
    `);
    // Inserted out of id order, so a read relying on physical order differs from one that sorts.
    await exec(`
      INSERT INTO ${t(
        'StorylineChapter'
      )} (id, "storylineId", "postId", "userId", depth, "removedAt") VALUES
        (${C_A_2}, ${S_A}, ${P_A_2}, ${U_AUTHOR}, 2, ${ts(REMOVED_AT)}),
        (${C_ROOT_A}, ${S_A}, ${P_ROOT_A}, ${U_AUTHOR}, 0, NULL),
        (${C_A_1}, ${S_A}, ${P_A_1}, ${U_BANNED}, 1, NULL),
        (${C_ROOT_B}, ${S_B}, ${P_ROOT_B}, ${U_DELETED}, 0, NULL),
        (${C_ROOT_C}, ${S_C}, NULL, ${U_AUTHOR}, 0, NULL),
        (${C_C_1}, ${S_C}, ${P_C_1}, ${U_AUTHOR}, 1, NULL),
        (${C_D_1}, ${S_D}, ${P_D_1}, ${U_OWNER}, 3, NULL)
    `);
    await exec(`
      INSERT INTO ${t(
        'Cosmetic'
      )} (id, name, description, type, source, data, "createdById", flags) VALUES
        (${CO_BADGE}, 'Badge', NULL, 'Badge', 'Claim', '{"url":"b"}', NULL, 0),
        (${CO_DECORATION}, 'Decoration', 'Lit', 'ContentDecoration', 'Purchase', '{"url":"d","lights":3}', ${U_OWNER}, 5),
        (${CO_PLATE}, 'Plate', 'Plain', 'NamePlate', 'Event', '{"color":"red"}', NULL, 2)
    `);
    // Out of primary-key order on purpose, and two claims of one cosmetic.
    await exec(`
      INSERT INTO ${t('UserCosmetic')}
        ("userId", "cosmeticId", "obtainedAt", "equippedAt", data, "claimKey", "equippedToId", "equippedToType", "forId", "forType")
      VALUES
        (${U_COLLECTOR}, ${CO_PLATE}, ${ts(
      OBTAINED_AT
    )}, NULL, NULL, 'claimed', NULL, NULL, ${M_A}, 'Model'),
        (${U_COLLECTOR}, ${CO_DECORATION}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, '{"lights":7}', 'claimed', ${P_ROOT_A}, 'Post', NULL, NULL),
        (${U_COLLECTOR}, ${CO_BADGE}, ${ts(
      OBTAINED_AT
    )}, NULL, '{"a":1}', 'second', NULL, NULL, NULL, NULL),
        (${U_COLLECTOR}, ${CO_BADGE}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, NULL, 'claimed', NULL, NULL, NULL, NULL),
        (${U_AUTHOR}, ${CO_PLATE}, ${ts(OBTAINED_AT)}, ${ts(
      EQUIPPED_AT
    )}, NULL, 'claimed', NULL, NULL, NULL, NULL)
    `);
    await exec(
      `INSERT INTO ${t('Model')} (id, "userId") VALUES (${M_A}, ${U_OWNER}), (${M_B}, ${U_AUTHOR})`
    );
    await exec(`
      INSERT INTO ${t('ModelVersion')} (id, "modelId") VALUES (${MV_A}, ${M_A}), (${MV_B}, ${M_B})
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
  });

  describe("a page of posts' storyline chapters", () => {
    it.each([
      ['no post is a chapter', [P_PLAIN, P_MISSING]],
      ['a first chapter and two later ones of one story', [P_A_2, P_ROOT_A, P_A_1]],
      ["a banned owner's story, whose first chapter's author is deleted", [P_ROOT_B]],
      ['a story whose first chapter lost its post', [P_C_1]],
      ['a story with no first chapter', [P_D_1]],
      ['everything at once', [P_ROOT_A, P_A_1, P_A_2, P_ROOT_B, P_C_1, P_D_1, P_PLAIN, P_MISSING]],
      ['no posts', []],
    ])('%s', async (_, ids) => {
      expect(byId(await readStorylineChaptersForPostsViaKysely(kysely, ids))).toStrictEqual(
        byId(await readStorylineChaptersForPostsViaPrisma(prisma, ids))
      );
    });

    it('control: each branch reads the fixture expected', async () => {
      expect(await readStorylineChaptersForPostsViaKysely(kysely, [P_C_1, P_PLAIN])).toStrictEqual([
        {
          id: C_C_1,
          postId: P_C_1,
          depth: 1,
          removedAt: null,
          post: {
            nsfwLevel: 16,
            userId: U_AUTHOR,
            tosViolation: false,
            user: { bannedAt: null, deletedAt: null },
          },
          storyline: {
            id: S_C,
            title: 'Story C',
            userId: U_OWNER,
            maxNsfwLevel: 7,
            minorByScan: false,
            tosViolation: false,
            nsfwLevel: 1,
            moderatorNsfwLevel: null,
            user: { bannedAt: null, deletedAt: null },
            chapters: [{ id: C_ROOT_C, postId: null, removedAt: null, post: null }],
          },
        },
      ]);
      const [b] = await readStorylineChaptersForPostsViaKysely(kysely, [P_ROOT_B]);
      expect(b.storyline.user).toStrictEqual({ bannedAt: BANNED_AT, deletedAt: null });
      expect(b.storyline.chapters[0].post).toStrictEqual({
        nsfwLevel: 2,
        publishedAt: null,
        tosViolation: false,
        user: { bannedAt: null, deletedAt: DELETED_AT },
      });
      const [d] = await readStorylineChaptersForPostsViaKysely(kysely, [P_D_1]);
      expect(d.storyline.chapters).toStrictEqual([]);
      const a = byId(await readStorylineChaptersForPostsViaKysely(kysely, [P_A_1, P_A_2]));
      expect(a.map((c) => [c.id, c.removedAt, c.post?.user.bannedAt ?? null])).toStrictEqual([
        [C_A_1, null, BANNED_AT],
        [C_A_2, REMOVED_AT, null],
      ]);
      // Two chapters of one story do not share objects, as Prisma's do not.
      expect(a[0].storyline).not.toBe(a[1].storyline);
    });
  });

  describe("a user's cosmetics", () => {
    it.each<[string, UserCosmeticsInput]>([
      ['all of them', { userId: U_COLLECTOR }],
      ['all of them, said explicitly', { userId: U_COLLECTOR, equipped: false }],
      ['the equipped ones', { userId: U_COLLECTOR, equipped: true }],
      ['another user', { userId: U_AUTHOR }],
      ['a user with none', { userId: U_NO_COSMETICS }],
      ['a user with none, equipped', { userId: U_NO_COSMETICS, equipped: true }],
      ['no such user', { userId: U_GONE }],
    ])('%s', async (_, input) => {
      expect(sortedCosmetics(await readUserCosmeticsViaKysely(kysely, input))).toStrictEqual(
        sortedCosmetics(await readUserCosmeticsViaPrisma(prisma, input))
      );
    });

    it('control: each branch reads the fixture expected, in primary-key order', async () => {
      const all = await readUserCosmeticsViaKysely(kysely, { userId: U_COLLECTOR });
      expect(all?.cosmetics.map((c) => [c.cosmetic.id, c.claimKey])).toStrictEqual([
        [CO_BADGE, 'claimed'],
        [CO_BADGE, 'second'],
        [CO_DECORATION, 'claimed'],
        [CO_PLATE, 'claimed'],
      ]);
      expect(all?.cosmetics[2]).toStrictEqual({
        obtainedAt: OBTAINED_AT,
        equippedAt: EQUIPPED_AT,
        equippedToId: P_ROOT_A,
        equippedToType: 'Post',
        forId: null,
        forType: null,
        claimKey: 'claimed',
        data: { lights: 7 },
        cosmetic: {
          id: CO_DECORATION,
          name: 'Decoration',
          description: 'Lit',
          type: 'ContentDecoration',
          source: 'Purchase',
          data: { url: 'd', lights: 3 },
          createdById: U_OWNER,
          flags: 5,
        },
      });
      expect(all?.cosmetics[3].forType).toBe('Model');
      // The twin's cosmetic carries exactly the pinned field list (checked against the shared
      // selector offline below), so a field added there and not here fails one of the two.
      expect(Object.keys(all?.cosmetics[0].cosmetic ?? {})).toEqual([
        ...USER_COSMETIC_COSMETIC_FIELDS,
      ]);
      const equipped = await readUserCosmeticsViaKysely(kysely, {
        userId: U_COLLECTOR,
        equipped: true,
      });
      expect(equipped?.cosmetics.map((c) => [c.cosmetic.id, c.claimKey])).toStrictEqual([
        [CO_BADGE, 'claimed'],
        [CO_DECORATION, 'claimed'],
      ]);
      expect(await readUserCosmeticsViaKysely(kysely, { userId: U_NO_COSMETICS })).toStrictEqual({
        cosmetics: [],
      });
      expect(await readUserCosmeticsViaKysely(kysely, { userId: U_GONE })).toBeNull();
    });
  });

  describe('a model version with its model owner', () => {
    it.each([
      ['one version', MV_A],
      ['another', MV_B],
    ])('%s', async (_, id) => {
      expect(await readDonationGoalVersionViaKysely(kysely, id)).toStrictEqual(
        await readDonationGoalVersionViaPrisma(prisma, id)
      );
    });

    it('no such version: both reject', async () => {
      await expect(readDonationGoalVersionViaPrisma(prisma, MV_GONE)).rejects.toThrow();
      await expect(readDonationGoalVersionViaKysely(kysely, MV_GONE)).rejects.toThrow();
    });

    it('control: each branch reads the fixture expected', async () => {
      expect(await readDonationGoalVersionViaKysely(kysely, MV_A)).toStrictEqual({
        id: MV_A,
        modelId: M_A,
        model: { userId: U_OWNER },
      });
      expect((await readDonationGoalVersionViaKysely(kysely, MV_B)).model.userId).toBe(U_AUTHOR);
    });
  });
});

// No statement reads a VIEW. Offline: the statements are compiled, not run.

describe('hot reads 8: no statement reads a view', () => {
  const TABLES = [
    'StorylineChapter',
    'Storyline',
    'Post',
    'User',
    'UserCosmetic',
    'Cosmetic',
    'Model',
    'ModelVersion',
  ];

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
    // The dummy driver returns no rows, so this is the no-chapter page: one statement.
    [
      'storyline chapters (no post is a chapter)',
      (db) => readStorylineChaptersForPostsViaKysely(db, [1]),
      [['StorylineChapter']],
    ],
    ['storylines with owners', (db) => listStorylinesWithOwner(db, [1]), [['Storyline', 'User']]],
    ['first chapters', (db) => listStorylineRootChapters(db, [1]), [['StorylineChapter']]],
    ['posts with authors', (db) => listStorylinePostsWithAuthor(db, [1]), [['Post', 'User']]],
    [
      'user cosmetics',
      (db) => readUserCosmeticsViaKysely(db, { userId: 1, equipped: true }),
      [['User'], ['Cosmetic', 'UserCosmetic']],
    ],
    ['the user', (db) => getUserIdIfExists(db, 1), [['User']]],
    [
      'cosmetics with cosmetic',
      (db) => listUserCosmeticsWithCosmetic(db, { userId: 1 }),
      [['Cosmetic', 'UserCosmetic']],
    ],
    ['version with owner', (db) => getModelVersionWithOwner(db, 1), [['Model', 'ModelVersion']]],
    // An empty list issues no statement.
    ['an empty post id list', (db) => readStorylineChaptersForPostsViaKysely(db, []), []],
  ])('%s', async (_, read, expected) => {
    const relations = await compiledRelations(read);
    // An exact ledger: a joined view, or any extra relation or statement, fails here.
    expect(relations).toEqual(expected);
    const views = declaredViews();
    for (const relation of relations.flat()) expect(views.has(relation), relation).toBe(false);
  });

  it("the cosmetics twin's field list is the Prisma read's cosmetic select", () => {
    expect(Object.keys({ ...simpleCosmeticSelect, createdById: true, flags: true })).toEqual([
      ...USER_COSMETIC_COSMETIC_FIELDS,
    ]);
  });
});

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
