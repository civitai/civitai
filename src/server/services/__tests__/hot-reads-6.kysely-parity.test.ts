import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { compileHarness } from '@civitai/db-queries/test-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import {
  downloadFilesWhere,
  readActiveDonationGoalsViaKysely,
  readActiveDonationGoalsViaPrisma,
  readDownloadFilesViaKysely,
  readDownloadFilesViaPrisma,
  readExistingModelVersionIdsViaKysely,
  readExistingModelVersionIdsViaPrisma,
  readModelAssociationTargetsViaKysely,
  readModelAssociationTargetsViaPrisma,
  readModelPoiAndOwnerViaKysely,
  readModelPoiAndOwnerViaPrisma,
  readModelVersionEngagementsViaKysely,
  readModelVersionEngagementsViaPrisma,
  readModelVersionOwnerViaKysely,
  readModelVersionOwnerViaPrisma,
  readModelVersionPrivacyViaKysely,
  readModelVersionPrivacyViaPrisma,
  readPostDetailViaKysely,
  readPostDetailViaPrisma,
  readUserBannedAtViaKysely,
  readUserBannedAtViaPrisma,
  readUserIdByUsernameViaKysely,
  readUserIdByUsernameViaPrisma,
  readUserReviewsViaKysely,
  readUserReviewsViaPrisma,
  type UserReviewsInput,
} from '~/server/services/hot-reads-6.reads';
import type { DownloadFilesWhere, PostDetailViewer } from '@civitai/db-queries/hot-reads-6';
import { AssociationType } from '~/shared/utils/prisma/enums';

/**
 * Parity gate for the reads behind `kysely-hot-reads-6`. Both paths run against the same rows in
 * the same database and must return the same value, `toStrictEqual`: the same keys, timestamps as
 * UTC Dates, enums as strings, JSON as parsed values, NULL as `null`, floats as numbers. A read
 * with no `orderBy` is unordered on both sides, so both are compared sorted (nested lists too).
 *
 * Where a Kysely twin answers `undefined` (a row it cannot map: an orphaned required relation), the
 * caller runs the Prisma read instead, so those cases compare the caller's composite, settled, with
 * the Prisma read settled: the same value or the same rejection.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_6_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost. Locally, KYSELY_PARITY_DATABASE_URL
 * works too, and must point at a THROWAWAY database: the suite drops and recreates the
 * `hot_reads_6_parity` schema. It deliberately does NOT fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles every statement the Kysely readers
 * issue and checks the relations they name against `schema.full.prisma`, so none of them reads a
 * VIEW.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_6_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_6_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-6-parity-schema.sql'));

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

// Distinct ids per table, and none equal to a count, an amount or another table's id.
const OWNER = 6101; // a profile picture, one listed cosmetic and two that are not
const DANGLING = 6102; // banned, a profile picture id pointing at no image, a NULL-data cosmetic
const DELETED = 6103; // deleted, no username, NULL settings
const VIEWER = 6104;
const MANAGER = 6105;
const USER_GONE = 6199;

const IMG_AVATAR = 6401;
const IMG_GONE = 6499;

const C_BADGE = 6501;
const C_PLATE = 6502;

const M_A = 6201;
const M_POI = 6202;
const M_USER_GONE = 6203;
const M_GONE = 6299;

const MV_A = 6301; // published
const MV_POI = 6302; // unpublished
const MV_MODEL_GONE = 6303;
const MV_USER_GONE = 6304;
const MV_DELETED_OWNER = 6305;
const MV_GONE = 6399;

const P_PUBLIC = 6601;
const P_UNPUBLISHED_MV = 6602;
const P_DRAFT = 6603;
const P_LEVEL_0 = 6604;
const P_FUTURE = 6605;
const P_COLLECTION = 6606;
const P_COLLECTION_GONE = 6607;
const P_USER_GONE = 6608;
const P_MV_GONE = 6609;
const P_MISSING = 6699;

const T_ONE = 6701;
const T_CATEGORY = 6702;
const T_GONE = 6799;

const COL = 6801;
const COL_GONE = 6899;

const G_ACTIVE = 6901;
const G_INACTIVE = 6902;
const G_OTHER_ENTITY = 6903;
const G_ACTIVE_POI = 6904;

const F_MODEL = 7201;
const F_CONFIG_PRIVATE = 7202;
const F_REPLACED = 7203;
const F_SENSITIVE = 7204;

const sortBy =
  <T>(key: (row: T) => number) =>
  (rows: T[]) =>
    [...rows].sort((a, b) => key(a) - key(b));

/** `fn`'s value, or the class of the error it rejected with. */
async function settle(fn: () => Promise<unknown>) {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error: (error as Error).constructor.name };
  }
}

describe.skipIf(!parityUrl)('hot reads 6: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl && withSchema(parityUrl) });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;
  const exec = (statement: string) => prisma.$executeRawUnsafe(statement);

  beforeAll(async () => {
    for (const statement of schemaStatements) await exec(statement);

    await exec(`
      INSERT INTO ${t('User')} (id, username, image, "deletedAt", "bannedAt", "profilePictureId",
        settings) VALUES
        (${OWNER}, 'owner', 'o.png', NULL, NULL, ${IMG_AVATAR}, '{"metricPrivacy": {"downloads": "hidden"}}'),
        (${DANGLING}, 'dangling', NULL, NULL, '2026-03-04 05:06:07.089', ${IMG_GONE}, '{}'),
        (${DELETED}, NULL, NULL, '2026-01-02 03:04:05.678', NULL, NULL, NULL),
        (${VIEWER}, 'viewer', 'v.png', NULL, NULL, NULL, '{}'),
        (${MANAGER}, 'manager', NULL, NULL, NULL, NULL, '{}')
    `);
    await exec(`
      INSERT INTO ${t('Image')} (id, name, url, "nsfwLevel", hash, "userId", ingestion, type, width,
        height, metadata) VALUES
        (${IMG_AVATAR}, NULL, 'avatar-url', 2, 'h1', ${OWNER}, 'Scanned', 'video', 64, NULL,
          '{"profile": true, "nested": [1, null]}')
    `);
    await exec(`
      INSERT INTO ${t('Cosmetic')} (id, name, type, source, data) VALUES
        (${C_BADGE}, 'Badge', 'Badge', 'Trophy', '{"url": "b.png"}'),
        (${C_PLATE}, 'Plate', 'NamePlate', 'Purchase', '{"gradient": [1, 2]}')
    `);
    await exec(`
      INSERT INTO ${t('UserCosmetic')} ("userId", "cosmeticId", "claimKey", "equippedAt",
        "equippedToId", data) VALUES
        (${OWNER}, ${C_BADGE}, 'claimed', '2026-03-01 00:00:00.000', NULL, '{"x": 1}'),
        (${OWNER}, ${C_PLATE}, 'claimed', '2026-03-01 00:00:00.000', 77, NULL),
        (${OWNER}, ${C_PLATE}, 'other', NULL, NULL, NULL),
        (${DANGLING}, ${C_BADGE}, 'claimed', '2026-03-02 00:00:00.000', NULL, NULL),
        (${DANGLING}, ${C_PLATE}, 'claimed', '2026-03-02 00:00:00.000', NULL, '"plain"')
    `);
    await exec(`
      INSERT INTO ${t('Model')} (id, poi, "userId", meta) VALUES
        (${M_A}, false, ${OWNER}, '{"showcaseCollectionId": 3}'),
        (${M_POI}, true, ${DANGLING}, '{}'),
        (${M_USER_GONE}, false, ${USER_GONE}, '{}'),
        (6204, false, ${DELETED}, '{"metricPrivacy": {}}')
    `);
    await exec(`
      INSERT INTO ${t('ModelVersion')} (id, "modelId", "publishedAt", meta) VALUES
        (${MV_A}, ${M_A}, '2026-02-01 00:00:00.000', '{"v": 1}'),
        (${MV_POI}, ${M_POI}, NULL, '{}'),
        (${MV_MODEL_GONE}, ${M_GONE}, NULL, '{}'),
        (${MV_USER_GONE}, ${M_USER_GONE}, NULL, '{}'),
        (${MV_DELETED_OWNER}, 6204, NULL, '{"metricPrivacy": {"downloads": "hidden"}}')
    `);
    await exec(`INSERT INTO ${t('Collection')} (id) VALUES (${COL})`);
    await exec(`
      INSERT INTO ${t('CollectionContributor')} ("userId", "collectionId", permissions) VALUES
        (${MANAGER}, ${COL}, '{VIEW,MANAGE}'),
        (${VIEWER}, ${COL}, '{VIEW,ADD}'),
        (${MANAGER}, ${COL_GONE}, '{MANAGE}')
    `);
    await exec(`
      INSERT INTO ${t('Post')} (id, nsfw, "nsfwLevel", title, detail, "modelVersionId", "userId",
        "publishedAt", availability, "collectionId") VALUES
        (${P_PUBLIC}, true, 4, 'Public', '<p>d</p>', ${MV_A}, ${OWNER}, '2020-01-01 00:00:00.123',
          'Public', NULL),
        (${P_UNPUBLISHED_MV}, false, 1, NULL, NULL, ${MV_POI}, ${DANGLING}, '2020-01-02 00:00:00.000',
          'Private', NULL),
        (${P_DRAFT}, false, 1, 'Draft', NULL, NULL, ${OWNER}, NULL, 'Public', NULL),
        (${P_LEVEL_0}, false, 0, 'Level 0', NULL, NULL, ${DELETED}, '2020-01-03 00:00:00.000',
          'Unsearchable', NULL),
        (${P_FUTURE}, false, 1, 'Future', NULL, NULL, ${OWNER}, '2999-01-01 00:00:00.000', 'Public',
          NULL),
        (${P_COLLECTION}, false, 0, 'In a collection', NULL, NULL, ${DANGLING}, NULL, 'Public',
          ${COL}),
        (${P_COLLECTION_GONE}, false, 0, 'Collection gone', NULL, NULL, ${DANGLING}, NULL, 'Public',
          ${COL_GONE}),
        (${P_USER_GONE}, false, 1, 'User gone', NULL, NULL, ${USER_GONE}, '2020-01-04 00:00:00.000',
          'Public', NULL),
        (${P_MV_GONE}, false, 2, 'Version gone', NULL, ${MV_GONE}, ${VIEWER},
          '2020-01-05 00:00:00.000', 'EarlyAccess', NULL)
    `);
    await exec(`
      INSERT INTO ${t('Tag')} (id, name, "isCategory") VALUES
        (${T_ONE}, 'one', false), (${T_CATEGORY}, 'category', true)
    `);
    await exec(`
      INSERT INTO ${t('TagsOnPost')} ("postId", "tagId") VALUES
        (${P_PUBLIC}, ${T_CATEGORY}), (${P_PUBLIC}, ${T_ONE}), (${P_PUBLIC}, ${T_GONE}),
        (${P_DRAFT}, ${T_ONE})
    `);
    await exec(`
      INSERT INTO ${t('DonationGoal')} (id, "userId", title, description, "goalAmount",
        "entityType", "entityId", "createdAt", active) VALUES
        (${G_ACTIVE}, ${OWNER}, 'Goal', NULL, 5000, 'ModelVersion', ${MV_A},
          '2026-04-01 01:02:03.004', true),
        (${G_INACTIVE}, ${OWNER}, 'Draft goal', 'draft', 6000, 'ModelVersion', ${MV_A},
          '2026-04-02 00:00:00.000', false),
        (${G_OTHER_ENTITY}, ${DANGLING}, 'Chapter goal', NULL, 7000, 'ComicChapter', ${MV_POI},
          '2026-04-03 00:00:00.000', true),
        (${G_ACTIVE_POI}, ${DANGLING}, 'Poi goal', 'desc', 8000, 'ModelVersion', ${MV_POI},
          '2026-04-04 00:00:00.000', true)
    `);
    await exec(`
      INSERT INTO ${t('ModelVersionEngagement')} ("userId", "modelVersionId", type) VALUES
        (${VIEWER}, ${MV_A}, 'Notify'), (${VIEWER}, ${MV_POI}, 'Notify'), (${OWNER}, ${MV_A}, 'Notify')
    `);
    await exec(`
      INSERT INTO ${t('ModelAssociations')} (id, "fromModelId", "toModelId", "toArticleId", type,
        index) VALUES
        (7001, ${M_A}, ${M_POI}, NULL, 'Suggested', 2),
        (7002, ${M_A}, NULL, 55, 'Suggested', 0),
        (7003, ${M_A}, ${M_USER_GONE}, NULL, 'Suggested', NULL),
        (7004, ${M_A}, NULL, 56, 'Suggested', 1),
        (7005, ${M_POI}, ${M_A}, NULL, 'Suggested', 0)
    `);
    await exec(`
      INSERT INTO ${t('ResourceReview')} (id, "modelId", "modelVersionId", "userId", recommended)
        VALUES
        (7101, ${M_A}, ${MV_A}, ${VIEWER}, true),
        (7102, ${M_POI}, ${MV_POI}, ${VIEWER}, false),
        (7103, ${M_USER_GONE}, ${MV_USER_GONE}, ${VIEWER}, true),
        (7104, ${M_A}, ${MV_A}, ${OWNER}, true)
    `);
    await exec(`
      INSERT INTO ${t('ModelFile')} (id, name, "overrideName", url, "sizeKB", type,
        "modelVersionId", metadata, visibility, "replacedAt") VALUES
        (${F_MODEL}, 'model.safetensors', NULL, 'u1', 1234.5, 'Model', ${MV_A},
          '{"fp": "fp16", "size": "full"}', 'Public', NULL),
        (${F_CONFIG_PRIVATE}, 'config.yaml', 'override.yaml', 'u2', 0.25, 'Config', ${MV_A}, NULL,
          'Private', NULL),
        (${F_REPLACED}, 'old.safetensors', NULL, 'u3', 99, 'Model', ${MV_A}, '{}', 'Public',
          '2026-04-05 00:00:00.000'),
        (${F_SENSITIVE}, 'sensitive.safetensors', NULL, 'u4', 2048, 'Model', ${MV_A}, '{}',
          'Sensitive', NULL),
        (7205, 'other.safetensors', NULL, 'u5', 1, 'Model', ${MV_POI}, '{}', 'Public', NULL)
    `);
    await exec(`
      INSERT INTO ${t('ModelFileHash')} ("fileId", type, hash) VALUES
        (${F_MODEL}, 'SHA256', 'SHA-MODEL'), (${F_MODEL}, 'AutoV2', 'AUTOV2'),
        (${F_SENSITIVE}, 'SHA256', 'SHA-SENSITIVE'), (${F_REPLACED}, 'BLAKE3', 'B3')
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
  });

  // Sorting the unordered nested lists a userWithCosmeticsSelect payload holds.
  const normalizeUser = <U extends { cosmetics: { cosmetic: { id: number } }[] }>(user: U) => ({
    ...user,
    cosmetics: sortBy((c: U['cosmetics'][number]) => c.cosmetic.id)(user.cosmetics),
  });

  describe("a model version's owner", () => {
    const viaService = async (id: number) =>
      (await readModelVersionOwnerViaKysely(kysely, id)) ??
      (await readModelVersionOwnerViaPrisma(prisma, id));

    it.each([
      ['an owner with a picture and cosmetics', MV_A],
      ['an owner with a dangling picture id and NULL-data cosmetics', MV_POI],
      ['a deleted owner with no username', MV_DELETED_OWNER],
      ['a missing version', MV_GONE],
      ['a version whose model is gone', MV_MODEL_GONE],
      ["a version whose model's user is gone", MV_USER_GONE],
    ])('%s', async (_, id) => {
      const normalize = (read: Awaited<ReturnType<typeof viaService>>) =>
        read && { model: { user: normalizeUser(read.model.user) } };
      const viaPrisma = await settle(async () =>
        normalize(await readModelVersionOwnerViaPrisma(prisma, id))
      );
      const viaKysely = await settle(async () => normalize(await viaService(id)));
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: each branch reads the fixture expected', async () => {
      expect(await readModelVersionOwnerViaKysely(kysely, MV_A)).toStrictEqual({
        model: {
          user: {
            id: OWNER,
            username: 'owner',
            deletedAt: null,
            image: 'o.png',
            profilePicture: {
              id: IMG_AVATAR,
              name: null,
              url: 'avatar-url',
              nsfwLevel: 2,
              hash: 'h1',
              userId: OWNER,
              ingestion: 'Scanned',
              type: 'video',
              width: 64,
              height: null,
              metadata: { profile: true, nested: [1, null] },
            },
            cosmetics: [
              {
                data: { x: 1 },
                cosmetic: {
                  id: C_BADGE,
                  data: { url: 'b.png' },
                  type: 'Badge',
                  source: 'Trophy',
                  name: 'Badge',
                },
              },
            ],
          },
        },
      });
      const dangling = await readModelVersionOwnerViaKysely(kysely, MV_POI);
      expect(dangling?.model.user.profilePicture).toBeNull();
      expect(normalizeUser(dangling!.model.user).cosmetics.map((c) => c.data)).toStrictEqual([
        null,
        'plain',
      ]);
      expect(
        (await readModelVersionOwnerViaKysely(kysely, MV_DELETED_OWNER))?.model.user.deletedAt
      ).toStrictEqual(new Date('2026-01-02T03:04:05.678Z'));
      // No row: the caller falls back to Prisma (null for a missing version, a throw for an orphan).
      for (const id of [MV_GONE, MV_MODEL_GONE, MV_USER_GONE])
        expect(await readModelVersionOwnerViaKysely(kysely, id)).toBeUndefined();
      expect(await readModelVersionOwnerViaPrisma(prisma, MV_GONE)).toBeNull();
    });
  });

  describe("a post's detail row", () => {
    const VIEWERS: [string, PostDetailViewer][] = [
      ['anonymous', undefined],
      ['a viewer', { id: VIEWER }],
      ['the owner', { id: OWNER }],
      ['a collection manager', { id: MANAGER }],
      ['a moderator', { id: VIEWER, isModerator: true }],
    ];
    const POSTS: [string, number][] = [
      ['public, with tags and a published version', P_PUBLIC],
      ['an unpublished linked version', P_UNPUBLISHED_MV],
      ['a draft', P_DRAFT],
      ['nsfwLevel 0', P_LEVEL_0],
      ['published in the future', P_FUTURE],
      ['in a managed collection', P_COLLECTION],
      ['in a collection with no row', P_COLLECTION_GONE],
      ['a linked version with no row', P_MV_GONE],
      ['a missing post', P_MISSING],
      ['a post whose user is gone', P_USER_GONE],
    ];
    type Read = Awaited<ReturnType<typeof readPostDetailViaPrisma>>;
    const normalize = (read: Read) =>
      read && {
        ...read,
        user: normalizeUser(read.user),
        tags: sortBy((tag: (typeof read.tags)[number]) => tag.tag.id)(read.tags),
      };

    describe.each(VIEWERS)('%s', (_, viewer) => {
      it.each(POSTS)('%s', async (__, id) => {
        const viaPrisma = await settle(async () =>
          normalize(await readPostDetailViaPrisma(prisma, { id, viewer }))
        );
        const viaKysely = await settle(async () => {
          const read = await readPostDetailViaKysely(kysely, { id, viewer, now: new Date() });
          return normalize(
            read === undefined ? await readPostDetailViaPrisma(prisma, { id, viewer }) : read
          );
        });
        expect(viaKysely).toStrictEqual(viaPrisma);
      });
    });

    it('control: visibility per viewer is the fixture expected', async () => {
      const visible = async (viewer: PostDetailViewer) => {
        const ids: number[] = [];
        for (const [, id] of POSTS)
          if (await readPostDetailViaKysely(kysely, { id, viewer, now: new Date() })) ids.push(id);
        return ids.sort((a, b) => a - b);
      };
      const publicIds = [P_PUBLIC, P_UNPUBLISHED_MV, P_MV_GONE];
      expect(await visible(undefined)).toStrictEqual(publicIds);
      expect(await visible({ id: OWNER })).toStrictEqual(
        [...publicIds, P_DRAFT, P_FUTURE].sort((a, b) => a - b)
      );
      expect(await visible({ id: MANAGER })).toStrictEqual(
        [...publicIds, P_COLLECTION].sort((a, b) => a - b)
      );
      expect(await visible({ id: VIEWER })).toStrictEqual(publicIds);
      expect(await visible({ id: VIEWER, isModerator: true })).toStrictEqual(
        [...POSTS.map(([, id]) => id).filter((id) => id !== P_MISSING && id !== P_USER_GONE)].sort(
          (a, b) => a - b
        )
      );
      // The post's own row is found; only its user is missing, so the caller runs Prisma.
      expect(
        await readPostDetailViaKysely(kysely, {
          id: P_USER_GONE,
          viewer: undefined,
          now: new Date(),
        })
      ).toBeUndefined();
    });

    it('control: the public post reads the fixture expected', async () => {
      const read = await readPostDetailViaKysely(kysely, {
        id: P_PUBLIC,
        viewer: undefined,
        now: new Date(),
      });
      expect({ ...read, user: read?.user.id, tags: normalize(read!)!.tags }).toStrictEqual({
        id: P_PUBLIC,
        nsfw: true,
        nsfwLevel: 4,
        title: 'Public',
        detail: '<p>d</p>',
        modelVersionId: MV_A,
        modelVersion: { id: MV_A },
        user: OWNER,
        publishedAt: new Date('2020-01-01T00:00:00.123Z'),
        availability: 'Public',
        tags: [
          { tag: { id: T_ONE, name: 'one', isCategory: false } },
          { tag: { id: T_CATEGORY, name: 'category', isCategory: true } },
        ],
        collectionId: null,
      });
      const unpublishedVersion = await readPostDetailViaKysely(kysely, {
        id: P_UNPUBLISHED_MV,
        viewer: undefined,
        now: new Date(),
      });
      expect(unpublishedVersion?.modelVersionId).toBe(MV_POI);
      expect(unpublishedVersion?.modelVersion).toBeNull();
      expect(unpublishedVersion?.availability).toBe('Private');
    });
  });

  describe("a model's POI flag and owner", () => {
    it.each([
      ['a model', M_A],
      ['a POI model', M_POI],
      ['a missing model', M_GONE],
    ])('%s', async (_, id) => {
      expect(await readModelPoiAndOwnerViaKysely(kysely, id)).toStrictEqual(
        await readModelPoiAndOwnerViaPrisma(prisma, id)
      );
    });

    it('control', async () => {
      expect(await readModelPoiAndOwnerViaKysely(kysely, M_POI)).toStrictEqual({
        poi: true,
        userId: DANGLING,
      });
      expect(await readModelPoiAndOwnerViaKysely(kysely, M_GONE)).toBeNull();
    });
  });

  describe('a user by username', () => {
    it.each(['owner', 'dangling', 'viewer', 'missing'])('id of %s', async (username) => {
      expect(await readUserIdByUsernameViaKysely(kysely, username)).toStrictEqual(
        await readUserIdByUsernameViaPrisma(prisma, username)
      );
    });

    it.each(['owner', 'dangling', 'missing'])('bannedAt of %s', async (username) => {
      expect(await readUserBannedAtViaKysely(kysely, username)).toStrictEqual(
        await readUserBannedAtViaPrisma(prisma, username)
      );
    });

    it('control', async () => {
      expect(await readUserIdByUsernameViaKysely(kysely, 'viewer')).toStrictEqual({ id: VIEWER });
      expect(await readUserIdByUsernameViaKysely(kysely, 'missing')).toBeNull();
      expect(await readUserBannedAtViaKysely(kysely, 'dangling')).toStrictEqual({
        bannedAt: new Date('2026-03-04T05:06:07.089Z'),
      });
      expect(await readUserBannedAtViaKysely(kysely, 'owner')).toStrictEqual({ bannedAt: null });
      expect(await readUserBannedAtViaKysely(kysely, 'missing')).toBeNull();
    });
  });

  describe('the public donation goals lookup', () => {
    const byIdRows = sortBy((row: { id: number }) => row.id);

    it.each([
      ['existing and missing', [MV_A, MV_POI, MV_GONE]],
      ['none existing', [MV_GONE]],
      ['empty', []],
    ])('existing version ids: %s', async (_, ids) => {
      expect(byIdRows(await readExistingModelVersionIdsViaKysely(kysely, ids))).toStrictEqual(
        byIdRows(await readExistingModelVersionIdsViaPrisma(prisma, ids))
      );
    });

    it.each([
      ['both versions', [MV_A, MV_POI]],
      ['one version', [MV_A]],
      ['no goals', [MV_GONE]],
      ['empty', []],
    ])('active goals: %s', async (_, ids) => {
      expect(byIdRows(await readActiveDonationGoalsViaKysely(kysely, ids))).toStrictEqual(
        byIdRows(await readActiveDonationGoalsViaPrisma(prisma, ids))
      );
    });

    it('control: only active ModelVersion goals, with their columns', async () => {
      expect(
        byIdRows(await readActiveDonationGoalsViaKysely(kysely, [MV_A, MV_POI]))
      ).toStrictEqual([
        {
          id: G_ACTIVE,
          goalAmount: 5000,
          title: 'Goal',
          active: true,
          userId: OWNER,
          createdAt: new Date('2026-04-01T01:02:03.004Z'),
          description: null,
          entityId: MV_A,
        },
        {
          id: G_ACTIVE_POI,
          goalAmount: 8000,
          title: 'Poi goal',
          active: true,
          userId: DANGLING,
          createdAt: new Date('2026-04-04T00:00:00.000Z'),
          description: 'desc',
          entityId: MV_POI,
        },
      ]);
    });
  });

  describe("a user's version engagements", () => {
    const byVersion = sortBy((row: { modelVersionId: number }) => row.modelVersionId);
    it.each([
      ['two engaged', { userId: VIEWER, modelVersionIds: [MV_A, MV_POI, MV_GONE] }],
      ['another user', { userId: OWNER, modelVersionIds: [MV_A, MV_POI] }],
      ['none engaged', { userId: MANAGER, modelVersionIds: [MV_A] }],
      ['no versions', { userId: VIEWER, modelVersionIds: [] }],
    ])('%s', async (_, input) => {
      expect(byVersion(await readModelVersionEngagementsViaKysely(kysely, input))).toStrictEqual(
        byVersion(await readModelVersionEngagementsViaPrisma(prisma, input))
      );
    });

    it('control', async () => {
      expect(
        byVersion(
          await readModelVersionEngagementsViaKysely(kysely, {
            userId: VIEWER,
            modelVersionIds: [MV_A, MV_POI],
          })
        )
      ).toStrictEqual([
        { modelVersionId: MV_A, type: 'Notify' },
        { modelVersionId: MV_POI, type: 'Notify' },
      ]);
    });
  });

  describe("a model's associated resources", () => {
    it.each([
      ['of a type', { fromModelId: M_A, type: AssociationType.Suggested }],
      ['of any type', { fromModelId: M_A }],
      ['one', { fromModelId: M_POI, type: AssociationType.Suggested }],
      ['none', { fromModelId: M_GONE, type: AssociationType.Suggested }],
    ])('%s', async (_, input) => {
      // Ordered by `index`: compared as returned, not sorted.
      expect(await readModelAssociationTargetsViaKysely(kysely, input)).toStrictEqual(
        await readModelAssociationTargetsViaPrisma(prisma, input)
      );
    });

    it('control: index ascending, NULL last', async () => {
      expect(
        await readModelAssociationTargetsViaKysely(kysely, {
          fromModelId: M_A,
          type: AssociationType.Suggested,
        })
      ).toStrictEqual([
        { toModelId: null, toArticleId: 55 },
        { toModelId: null, toArticleId: 56 },
        { toModelId: M_POI, toArticleId: null },
        { toModelId: M_USER_GONE, toArticleId: null },
      ]);
    });
  });

  describe("a user's reviews", () => {
    const byVersion = sortBy((row: { modelVersionId: number }) => row.modelVersionId);
    it.each<[string, UserReviewsInput]>([
      [
        'recommended, bounded to models',
        { userId: VIEWER, recommended: true, modelIds: [M_A, M_POI] },
      ],
      ['any, unbounded', { userId: VIEWER }],
      ['not recommended', { userId: VIEWER, recommended: false }],
      ['an empty model list', { userId: VIEWER, recommended: true, modelIds: [] }],
      ['no reviews', { userId: MANAGER, recommended: true }],
    ])('%s', async (_, input) => {
      expect(byVersion(await readUserReviewsViaKysely(kysely, input))).toStrictEqual(
        byVersion(await readUserReviewsViaPrisma(prisma, input))
      );
    });

    it('control', async () => {
      expect(
        await readUserReviewsViaKysely(kysely, {
          userId: VIEWER,
          recommended: true,
          modelIds: [M_A, M_POI],
        })
      ).toStrictEqual([{ modelId: M_A, modelVersionId: MV_A }]);
    });
  });

  describe("a model version's metric-privacy inputs", () => {
    it.each([
      ['an owner with settings', MV_A],
      ['an empty settings object', MV_POI],
      ['NULL settings', MV_DELETED_OWNER],
      ['a missing version', MV_GONE],
      ['a version whose model is gone', MV_MODEL_GONE],
      ["a version whose model's user is gone", MV_USER_GONE],
    ])('%s', async (_, id) => {
      const viaPrisma = await settle(() => readModelVersionPrivacyViaPrisma(prisma, id));
      const viaKysely = await settle(async () => {
        const read = await readModelVersionPrivacyViaKysely(kysely, id);
        return read === undefined ? readModelVersionPrivacyViaPrisma(prisma, id) : read;
      });
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control', async () => {
      expect(await readModelVersionPrivacyViaKysely(kysely, MV_A)).toStrictEqual({
        meta: { v: 1 },
        model: {
          meta: { showcaseCollectionId: 3 },
          userId: OWNER,
          user: { settings: { metricPrivacy: { downloads: 'hidden' } } },
        },
      });
      expect(
        (await readModelVersionPrivacyViaKysely(kysely, MV_DELETED_OWNER))?.model?.user.settings
      ).toBeNull();
      expect(await readModelVersionPrivacyViaKysely(kysely, MV_GONE)).toBeNull();
      expect(await readModelVersionPrivacyViaKysely(kysely, MV_MODEL_GONE)).toBeUndefined();
      expect(await readModelVersionPrivacyViaKysely(kysely, MV_USER_GONE)).toBeUndefined();
    });
  });

  describe("a version's download files", () => {
    const byFile = sortBy((row: { id: number }) => row.id);
    it.each<[string, DownloadFilesWhere]>([
      ['by id, public only', { modelVersionId: MV_A, publicOnly: true }],
      ['by id, owner', { modelVersionId: MV_A }],
      ['default, public only', { modelVersionId: MV_A, notReplaced: true, publicOnly: true }],
      ['default, owner', { modelVersionId: MV_A, notReplaced: true }],
      ['default, a type', { modelVersionId: MV_A, notReplaced: true, type: 'Config' }],
      ['default, an empty type', { modelVersionId: MV_A, notReplaced: true, type: '' }],
      ['default, a type with none', { modelVersionId: MV_A, notReplaced: true, type: 'VAE' }],
      ['another version', { modelVersionId: MV_POI, notReplaced: true, publicOnly: true }],
      ['no files', { modelVersionId: MV_GONE, notReplaced: true }],
    ])('%s', async (_, where) => {
      expect(byFile(await readDownloadFilesViaKysely(kysely, where))).toStrictEqual(
        byFile(await readDownloadFilesViaPrisma(prisma, downloadFilesWhere(where)))
      );
    });

    it('control: the default owner read is the fixture expected', async () => {
      expect(
        byFile(
          await readDownloadFilesViaKysely(kysely, { modelVersionId: MV_A, notReplaced: true })
        )
      ).toStrictEqual([
        {
          id: F_MODEL,
          url: 'u1',
          name: 'model.safetensors',
          overrideName: null,
          type: 'Model',
          metadata: { fp: 'fp16', size: 'full' },
          sizeKB: 1234.5,
          hashes: [{ hash: 'SHA-MODEL' }],
        },
        {
          id: F_CONFIG_PRIVATE,
          url: 'u2',
          name: 'config.yaml',
          overrideName: 'override.yaml',
          type: 'Config',
          metadata: null,
          sizeKB: 0.25,
          hashes: [],
        },
        {
          id: F_SENSITIVE,
          url: 'u4',
          name: 'sensitive.safetensors',
          overrideName: null,
          type: 'Model',
          metadata: {},
          sizeKB: 2048,
          hashes: [{ hash: 'SHA-SENSITIVE' }],
        },
      ]);
      expect(
        (
          await readDownloadFilesViaKysely(kysely, {
            modelVersionId: MV_A,
            notReplaced: true,
            publicOnly: true,
          })
        ).map((file) => file.id)
      ).toStrictEqual([F_MODEL]);
    });
  });
});

// No statement reads a VIEW. Offline: the statements are compiled, not run.

const SCHEMA_PRISMA = resolve(
  here,
  '../../../../packages/civitai-db-schema/prisma/schema.full.prisma'
);

const schemaLines = () => readFileSync(SCHEMA_PRISMA, 'utf-8').split('\n');
const isViewMarker = (line: string) => line.trim() === '/// @view';

/**
 * Every model declared `/// @view` in schema.full.prisma. The marker sits above the model, in its
 * doc comment block, sometimes with a blank line between them, so the walk up from each `model`
 * line skips blank and `///` lines and stops at anything else.
 */
function declaredViews(): Set<string> & { markersAttributed: number } {
  const lines = schemaLines();
  const views = new Set<string>();
  const attributed = new Set<number>();
  lines.forEach((line, i) => {
    const model = /^model (\w+) \{/.exec(line);
    if (!model) return;
    for (let j = i - 1; j >= 0 && (lines[j].trim() === '' || lines[j].startsWith('///')); j--)
      if (isViewMarker(lines[j])) {
        views.add(model[1]);
        attributed.add(j);
      }
  });
  return Object.assign(views, { markersAttributed: attributed.size });
}

/** The quoted relation names a compiled statement reads FROM or JOINs, sorted. */
function relationsOf(sqlText: string): string[] {
  return [...sqlText.matchAll(/\b(?:from|join)\s+"(\w+)"/gi)].map((match) => match[1]).sort();
}

async function compiledRelations(read: (db: never) => Promise<unknown>) {
  const harness = compileHarness();
  // The dummy driver returns no rows, so a read that requires one stops after its first statement.
  await read(harness.db as never).catch(() => undefined);
  return harness.queries.map((query) => relationsOf(query.sql));
}

describe('hot reads 6: no statement reads a view', () => {
  const TABLES = [
    'User',
    'Image',
    'UserCosmetic',
    'Cosmetic',
    'ModelVersion',
    'Model',
    'Post',
    'TagsOnPost',
    'Tag',
    'Collection',
    'CollectionContributor',
    'DonationGoal',
    'ModelVersionEngagement',
    'ModelAssociations',
    'ResourceReview',
    'ModelFile',
    'ModelFileHash',
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

  const USER = ['Cosmetic', 'Image', 'User', 'UserCosmetic'];
  it.each<[string, (db: never) => Promise<unknown>, string[][]]>([
    [
      "a model version's owner",
      (db) => readModelVersionOwnerViaKysely(db, 1),
      [[...USER, 'Model', 'ModelVersion'].sort()],
    ],
    [
      "a post's detail row (its user read follows a found row)",
      (db) => readPostDetailViaKysely(db, { id: 1, viewer: { id: 2 }, now: new Date(0) }),
      [['Collection', 'CollectionContributor', 'ModelVersion', 'Post', 'Tag', 'TagsOnPost']],
    ],
    ["a model's POI and owner", (db) => readModelPoiAndOwnerViaKysely(db, 1), [['Model']]],
    ['a user id by username', (db) => readUserIdByUsernameViaKysely(db, 'u'), [['User']]],
    ['a bannedAt by username', (db) => readUserBannedAtViaKysely(db, 'u'), [['User']]],
    [
      'existing version ids',
      (db) => readExistingModelVersionIdsViaKysely(db, [1]),
      [['ModelVersion']],
    ],
    [
      'active donation goals',
      (db) => readActiveDonationGoalsViaKysely(db, [1]),
      [['DonationGoal']],
    ],
    [
      'version engagements',
      (db) => readModelVersionEngagementsViaKysely(db, { userId: 1, modelVersionIds: [2] }),
      [['ModelVersionEngagement']],
    ],
    [
      'associated resources',
      (db) => readModelAssociationTargetsViaKysely(db, { fromModelId: 1 }),
      [['ModelAssociations']],
    ],
    ["a user's reviews", (db) => readUserReviewsViaKysely(db, { userId: 1 }), [['ResourceReview']]],
    [
      'metric-privacy inputs',
      (db) => readModelVersionPrivacyViaKysely(db, 1),
      [['Model', 'ModelVersion', 'User']],
    ],
    [
      'download files',
      (db) => readDownloadFilesViaKysely(db, { modelVersionId: 1, notReplaced: true }),
      [['ModelFile', 'ModelFileHash']],
    ],
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
