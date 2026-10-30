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
  countUnclaimedPrizesViaKysely,
  countUnclaimedPrizesViaPrisma,
  readDismissedAnnouncementIdsViaKysely,
  readDismissedAnnouncementIdsViaPrisma,
  readHomeBlockViaKysely,
  readHomeBlockViaPrisma,
  readImageNsfwLevelAndOwnerViaKysely,
  readImageNsfwLevelAndOwnerViaPrisma,
  readImagePostIdViaKysely,
  readImageReactionIdViaKysely,
  readImageReactionIdViaPrisma,
  readKeyValueViaKysely,
  readKeyValueViaPrisma,
  readModelMetaViaKysely,
  readModelMetaViaPrisma,
  readModelVersionForFileViaKysely,
  readModelVersionForFileViaPrisma,
  readModelVersionIdsViaKysely,
  readModelVersionIdsViaPrisma,
  readPostCollaboratorsViaKysely,
  readPostCollaboratorsViaPrisma,
  readPostModel3dViaKysely,
  readPostModel3dViaPrisma,
  readUserResourceReviewsViaKysely,
  readUserResourceReviewsViaPrisma,
  type DismissedAnnouncementIdsInput,
  type ImageReactionKey,
  type UserResourceReviewInput,
} from '~/server/services/hot-reads-5.reads';
import { DomainColor, ReviewReactions } from '~/shared/utils/prisma/enums';

/**
 * Parity gate for the reads behind `kysely-hot-reads-5`. Both paths run against the same rows in
 * the same database and must return the same value, `toStrictEqual`: the same keys in the same
 * order, timestamps as UTC Dates, enums as strings, JSON as parsed values, NULL as `null`, counts
 * as numbers. A read with no `orderBy` (the dismissed ids, the collaborators, the version ids, the
 * reviews) is unordered on both sides, so both are compared sorted.
 *
 * Every branch the twins map is a case with literal fixtures: a missing row, a NULL column, a NULL
 * relation, an orphaned relation, each filter and each enum the reads return.
 *
 * The Prisma side of each read is the reader the service runs (hot-reads-5.reads.ts), with one
 * exception: the `reaction.toggle` access check reads the whole image row through Prisma and keeps
 * its `postId`, and this fixture holds only some Image columns, so that read is compared against
 * the Prisma read of the `postId` column alone (`readImagePostIdViaPrisma` returns exactly that
 * column of that row).
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_5_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and a test below fails if that wiring is lost, so the suite cannot skip itself
 * there unnoticed. Locally, KYSELY_PARITY_DATABASE_URL works too, and must point at a THROWAWAY
 * database: the suite drops and recreates the `hot_reads_5_parity` schema. It deliberately does NOT
 * fall back to `DATABASE_URL`.
 *
 * The last block runs everywhere, without a database: it compiles every statement the Kysely readers
 * issue and checks the relations they name against `schema.full.prisma`, so none of them reads a
 * VIEW.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_5_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_5_parity';

const here = dirname(fileURLToPath(import.meta.url));
const schemaStatements = loadParitySchema(resolve(here, 'fixtures/hot-reads-5-parity-schema.sql'));

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

// Distinct ids per table, and none equal to a count or another table's id.
const OWNER = 5101;
const COLLAB_A = 5102; // a profile picture, one equipped and one unequipped cosmetic
const COLLAB_B = 5103; // deleted, no username, no picture
const COLLAB_C = 5104;
const VIEWER = 5105;
const NO_ONE = 5199;

const M3D_VISIBLE = 5201;
const M3D_DELETED = 5202;

const POST_WITH_M3D = 5301;
const POST_DELETED_M3D = 5302;
const POST_NO_M3D = 5303;
const POST_DANGLING_M3D = 5304; // model3dId points at no row
const POST_COLLABS = 5305;
const POST_MISSING = 5399;

const IMG_IN_POST = 5401;
const IMG_NO_POST = 5402;
const IMG_AVATAR = 5403;
const IMG_MISSING = 5499;

const COSMETIC_BADGE = 5501;
const COSMETIC_PLATE = 5502;

const ANN_LIVE_ALL = 5601;
const ANN_LIVE_RED = 5602;
const ANN_DISABLED = 5603;
const ANN_FUTURE = 5604;
const ANN_ENDED = 5605;
const ANN_OPEN = 5606; // NULL start and end, domain green
const ANN_LIVE_RED_BLUE = 5607;
const ANN_ENDS_NOW = 5608; // endsAt = now exactly (inclusive)

const HB_PLAIN = 5701;
const HB_SOURCE = 5702;
const HB_MISSING = 5799;

const MODEL_A = 5801;
const MODEL_TAKEN_DOWN = 5802;
const MODEL_EMPTY = 5803;
const MODEL_MISSING = 5899;

const MV_A1 = 5913;
const MV_A2 = 5911;
const MV_A3 = 5912;
const MV_TAKEN_DOWN = 5921;
const MV_NULL_WORDS = 5922;
const MV_ORPHAN = 5931; // its model row does not exist
const MV_MISSING = 5999;

const NOW = new Date('2026-05-10T12:00:00.000Z');

const sortNumbers = (ids: number[]) => [...ids].sort((a, b) => a - b);
const byId = <T extends { id: number }>(rows: T[]) => [...rows].sort((a, b) => a.id - b.id);

describe.skipIf(!parityUrl)('hot reads 5: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl && withSchema(parityUrl) });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;

  beforeAll(async () => {
    for (const statement of schemaStatements) await prisma.$executeRawUnsafe(statement);

    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('KeyValue')} (key, value) VALUES
        ('object', '{"a": 1, "nested": {"b": [true, null, "x"]}, "f": 1.5}'),
        ('array', '[3, 1, 2]'),
        ('string', '"plain"'),
        ('number', '42'),
        ('json-null', 'null')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('User')} (id, username, image, "deletedAt", "profilePictureId") VALUES
        (${OWNER}, 'owner', 'o.png', NULL, NULL),
        (${COLLAB_A}, 'alpha', 'a.png', NULL, ${IMG_AVATAR}),
        (${COLLAB_B}, NULL, NULL, '2026-01-02 03:04:05.678', NULL),
        (${COLLAB_C}, 'gamma', NULL, NULL, NULL),
        (${VIEWER}, 'viewer', NULL, NULL, NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Model3D')} (id, "userId", status, "deletedAt") VALUES
        (${M3D_VISIBLE}, ${OWNER}, 'Published', NULL),
        (${M3D_DELETED}, ${COLLAB_A}, 'Deleted', '2026-02-03 04:05:06.789')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Post')} (id, "userId", "model3dId") VALUES
        (${POST_WITH_M3D}, ${OWNER}, ${M3D_VISIBLE}),
        (${POST_DELETED_M3D}, ${COLLAB_A}, ${M3D_DELETED}),
        (${POST_NO_M3D}, ${COLLAB_B}, NULL),
        (${POST_DANGLING_M3D}, ${OWNER}, 5298),
        (${POST_COLLABS}, ${OWNER}, NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Image')} (id, name, url, "nsfwLevel", hash, "userId", ingestion, type, width,
        height, metadata, "postId") VALUES
        (${IMG_IN_POST}, 'in post', 'u1', 4, 'h1', ${OWNER}, 'Scanned', 'image', 512, 768,
          '{"size": 10}', ${POST_WITH_M3D}),
        (${IMG_NO_POST}, NULL, 'u2', 0, NULL, ${COLLAB_A}, 'Pending', 'video', NULL, NULL, '{}', NULL),
        (${IMG_AVATAR}, 'avatar', 'u3', 1, 'h3', ${COLLAB_A}, 'Scanned', 'image', 64, 64,
          '{"profile": true}', NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Cosmetic')} (id, name, type, source, data) VALUES
        (${COSMETIC_BADGE}, 'Badge', 'Badge', 'Trophy', '{"url": "b.png"}'),
        (${COSMETIC_PLATE}, 'Plate', 'NamePlate', 'Purchase', '{"gradient": [1, 2]}')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('UserCosmetic')} ("userId", "cosmeticId", "claimKey", "equippedAt",
        "equippedToId", data) VALUES
        (${COLLAB_A}, ${COSMETIC_BADGE}, 'claimed', '2026-03-01 00:00:00.000', NULL, '{"x": 1}'),
        (${COLLAB_A}, ${COSMETIC_PLATE}, 'claimed', NULL, NULL, NULL),
        (${COLLAB_C}, ${COSMETIC_PLATE}, 'claimed', '2026-03-02 00:00:00.000', NULL, NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Announcement')} (id, disabled, "startsAt", "endsAt", domain) VALUES
        (${ANN_LIVE_ALL}, false, '2026-05-01 00:00:00.000', '2026-06-01 00:00:00.000', '{all}'),
        (${ANN_LIVE_RED}, false, '2026-05-01 00:00:00.000', NULL, '{red}'),
        (${ANN_DISABLED}, true, NULL, NULL, '{all}'),
        (${ANN_FUTURE}, false, '2026-05-11 00:00:00.000', NULL, '{all}'),
        (${ANN_ENDED}, false, NULL, '2026-05-09 00:00:00.000', '{all}'),
        (${ANN_OPEN}, false, NULL, NULL, '{green}'),
        (${ANN_LIVE_RED_BLUE}, false, '2026-05-10 12:00:00.000', NULL, '{red,blue}'),
        (${ANN_ENDS_NOW}, false, NULL, '2026-05-10 12:00:00.000', '{blue}')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('AnnouncementDismissal')} ("announcementId", "userId") VALUES
        (${ANN_LIVE_ALL}, ${VIEWER}), (${ANN_LIVE_RED}, ${VIEWER}), (${ANN_DISABLED}, ${VIEWER}),
        (${ANN_FUTURE}, ${VIEWER}), (${ANN_ENDED}, ${VIEWER}), (${ANN_OPEN}, ${VIEWER}),
        (${ANN_LIVE_RED_BLUE}, ${VIEWER}), (${ANN_ENDS_NOW}, ${VIEWER}),
        (${ANN_LIVE_ALL}, ${OWNER})
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('EntityCollaborator')} ("entityType", "entityId", "userId", status) VALUES
        ('Post', ${POST_COLLABS}, ${COLLAB_C}, 'Approved'),
        ('Post', ${POST_COLLABS}, ${COLLAB_A}, 'Pending'),
        ('Post', ${POST_COLLABS}, ${COLLAB_B}, 'Rejected'),
        ('Image', ${POST_COLLABS}, ${VIEWER}, 'Approved'),
        ('Post', ${POST_WITH_M3D}, ${VIEWER}, 'Approved')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('HomeBlock')} (id, "userId", metadata, type, "sourceId") VALUES
        (${HB_PLAIN}, ${OWNER}, '{"title": "Hi", "collection": {"id": 3, "limit": 8}}', 'Collection', NULL),
        (${HB_SOURCE}, ${COLLAB_A}, '{}', 'CosmeticShop', 77)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Prize')} (id, "userId", "claimedAt", "voidedAt") VALUES
        (6001, ${VIEWER}, NULL, NULL),
        (6002, ${VIEWER}, NULL, NULL),
        (6003, ${VIEWER}, NULL, NULL),
        (6004, ${VIEWER}, '2026-01-01 00:00:00.000', NULL),
        (6005, ${VIEWER}, NULL, '2026-01-01 00:00:00.000'),
        (6006, ${OWNER}, NULL, NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Model')} (id, name, type, nsfw, poi, "userId", status, "publishedAt", meta,
        mode, availability) VALUES
        (${MODEL_A}, 'Model A', 'LORA', true, false, ${OWNER}, 'Published',
          '2026-04-01 01:02:03.004', '{"showcaseCollectionId": 12, "tags": ["x"]}', NULL, 'Public'),
        (${MODEL_TAKEN_DOWN}, 'Taken', 'Checkpoint', false, true, ${COLLAB_A}, 'Unpublished', NULL,
          '{}', 'TakenDown', 'EarlyAccess'),
        (${MODEL_EMPTY}, 'Empty', 'Other', false, false, ${OWNER}, 'Draft', NULL, '{}', 'Archived',
          'Private')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelVersion')} (id, name, "modelId", "trainedWords", "createdAt", status,
        "requireAuth", "usageControl") VALUES
        (${MV_A1}, 'v1', ${MODEL_A}, '{alpha,"two words"}', '2026-04-02 00:00:00.123', 'Published',
          false, 'Download'),
        (${MV_A2}, 'v2', ${MODEL_A}, '{}', '2026-04-03 00:00:00.000', 'Draft', true, 'Generation'),
        (${MV_A3}, 'v3', ${MODEL_A}, '{x}', '2026-04-04 00:00:00.000', 'Scheduled', false,
          'InternalGeneration'),
        (${MV_TAKEN_DOWN}, 'td', ${MODEL_TAKEN_DOWN}, '{y}', '2026-04-05 00:00:00.000',
          'UnpublishedViolation', true, 'ExternalGeneration'),
        (${MV_NULL_WORDS}, 'nw', ${MODEL_TAKEN_DOWN}, NULL, '2026-04-06 00:00:00.000', 'Published',
          false, 'Download'),
        (${MV_ORPHAN}, 'orphan', 5898, '{z}', '2026-04-07 00:00:00.000', 'Published', false,
          'Download')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ResourceReview')} (id, "modelId", "modelVersionId", "userId", recommended,
        details, "createdAt", exclude) VALUES
        (6103, ${MODEL_A}, ${MV_A1}, ${VIEWER}, true, '<p>good</p>', '2026-04-10 00:00:00.010', false),
        (6101, ${MODEL_A}, ${MV_A2}, ${VIEWER}, false, NULL, '2026-04-11 00:00:00.011', true),
        (6102, ${MODEL_TAKEN_DOWN}, ${MV_TAKEN_DOWN}, ${VIEWER}, true, 'ok', '2026-04-12 00:00:00.012', false),
        (6104, ${MODEL_A}, ${MV_A1}, ${OWNER}, true, 'own', '2026-04-13 00:00:00.013', false)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ImageReaction')} (id, "imageId", "userId", reaction) VALUES
        (6201, ${IMG_IN_POST}, ${VIEWER}, 'Like'),
        (6202, ${IMG_IN_POST}, ${VIEWER}, 'Heart'),
        (6203, ${IMG_NO_POST}, ${VIEWER}, 'Laugh'),
        (6204, ${IMG_IN_POST}, ${OWNER}, 'Cry')
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
  });

  describe('a KeyValue row', () => {
    it.each(['object', 'array', 'string', 'number', 'json-null', 'missing'])('%s', async (key) => {
      const viaPrisma = await readKeyValueViaPrisma(prisma, key);
      const viaKysely = await readKeyValueViaKysely(kysely, key);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: JSON values come back parsed, a JSON null as null, a missing key as null', async () => {
      expect(await readKeyValueViaKysely(kysely, 'object')).toStrictEqual({
        key: 'object',
        value: { a: 1, nested: { b: [true, null, 'x'] }, f: 1.5 },
      });
      expect(await readKeyValueViaKysely(kysely, 'json-null')).toStrictEqual({
        key: 'json-null',
        value: null,
      });
      expect(await readKeyValueViaKysely(kysely, 'missing')).toBeNull();
    });
  });

  describe("a post's linked Model3D", () => {
    it.each([
      ['a visible Model3D', POST_WITH_M3D],
      ['a deleted Model3D', POST_DELETED_M3D],
      ['no Model3D', POST_NO_M3D],
      ['a Model3D id pointing at no row', POST_DANGLING_M3D],
      ['a missing post', POST_MISSING],
    ])('%s', async (_, postId) => {
      const viaPrisma = await readPostModel3dViaPrisma(prisma, postId);
      const viaKysely = await readPostModel3dViaKysely(kysely, postId);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: each branch reads the fixture expected', async () => {
      expect(await readPostModel3dViaKysely(kysely, POST_DELETED_M3D)).toStrictEqual({
        model3d: {
          id: M3D_DELETED,
          userId: COLLAB_A,
          status: 'Deleted',
          deletedAt: new Date('2026-02-03T04:05:06.789Z'),
        },
      });
      expect(await readPostModel3dViaKysely(kysely, POST_NO_M3D)).toStrictEqual({ model3d: null });
      expect(await readPostModel3dViaKysely(kysely, POST_DANGLING_M3D)).toStrictEqual({
        model3d: null,
      });
      expect(await readPostModel3dViaKysely(kysely, POST_MISSING)).toBeNull();
    });
  });

  describe('the dismissed announcement ids', () => {
    const cases: [string, DismissedAnnouncementIdsInput][] = [
      ['every domain', { userId: VIEWER, now: NOW }],
      ['the red domain', { userId: VIEWER, now: NOW, domain: DomainColor.red }],
      ['the green domain', { userId: VIEWER, now: NOW, domain: DomainColor.green }],
      ['the blue domain', { userId: VIEWER, now: NOW, domain: DomainColor.blue }],
      ['another user', { userId: OWNER, now: NOW }],
      ['a user with none', { userId: NO_ONE, now: NOW }],
      ['a later now', { userId: VIEWER, now: new Date('2026-05-20T00:00:00.000Z') }],
    ];

    it.each(cases)('%s', async (_, input) => {
      const viaPrisma = await readDismissedAnnouncementIdsViaPrisma(prisma, input);
      const viaKysely = await readDismissedAnnouncementIdsViaKysely(kysely, input);
      expect(sortNumbers(viaKysely)).toStrictEqual(sortNumbers(viaPrisma));
    });

    it('control: the live window and the domain filter each drop the rows expected', async () => {
      const ids = async (input: DismissedAnnouncementIdsInput) =>
        sortNumbers(await readDismissedAnnouncementIdsViaKysely(kysely, input));
      expect(await ids({ userId: VIEWER, now: NOW })).toEqual([
        ANN_LIVE_ALL,
        ANN_LIVE_RED,
        ANN_OPEN,
        ANN_LIVE_RED_BLUE,
        ANN_ENDS_NOW,
      ]);
      expect(await ids({ userId: VIEWER, now: NOW, domain: DomainColor.red })).toEqual([
        ANN_LIVE_ALL,
        ANN_LIVE_RED,
        ANN_LIVE_RED_BLUE,
      ]);
      expect(await ids({ userId: VIEWER, now: NOW, domain: DomainColor.blue })).toEqual([
        ANN_LIVE_ALL,
        ANN_LIVE_RED_BLUE,
        ANN_ENDS_NOW,
      ]);
    });
  });

  describe("a post's collaborators", () => {
    const sortCollaborators = (read: Awaited<ReturnType<typeof readPostCollaboratorsViaPrisma>>) =>
      read && {
        entity: read.entity,
        collaborators: [...read.collaborators]
          .sort((a, b) => a.user.id - b.user.id)
          .map((c) => ({
            ...c,
            user: {
              ...c.user,
              cosmetics: [...c.user.cosmetics].sort((a, b) => a.cosmetic.id - b.cosmetic.id),
            },
          })),
      };

    it.each([
      ['three collaborators, one per status', POST_COLLABS],
      ['one collaborator', POST_WITH_M3D],
      ['no collaborators', POST_NO_M3D],
      ['a missing post', POST_MISSING],
    ])('%s', async (_, postId) => {
      const viaPrisma = await readPostCollaboratorsViaPrisma(prisma, postId);
      const viaKysely = await readPostCollaboratorsViaKysely(kysely, prisma, postId);
      expect(sortCollaborators(viaKysely)).toStrictEqual(sortCollaborators(viaPrisma));
    });

    it('control: the rows, their users and the post owner are the fixture expected', async () => {
      const read = sortCollaborators(
        await readPostCollaboratorsViaKysely(kysely, prisma, POST_COLLABS)
      );
      expect(read?.entity).toStrictEqual({ userId: OWNER });
      expect(
        read?.collaborators.map((c) => [c.user.id, c.entityId, c.entityType, c.status])
      ).toStrictEqual([
        [COLLAB_A, POST_COLLABS, 'Post', 'Pending'],
        [COLLAB_B, POST_COLLABS, 'Post', 'Rejected'],
        [COLLAB_C, POST_COLLABS, 'Post', 'Approved'],
      ]);
      expect(read?.collaborators[0].user).toStrictEqual({
        id: COLLAB_A,
        username: 'alpha',
        deletedAt: null,
        image: 'a.png',
        profilePicture: {
          id: IMG_AVATAR,
          name: 'avatar',
          url: 'u3',
          nsfwLevel: 1,
          hash: 'h3',
          userId: COLLAB_A,
          ingestion: 'Scanned',
          type: 'image',
          width: 64,
          height: 64,
          metadata: { profile: true },
        },
        cosmetics: [
          {
            data: { x: 1 },
            cosmetic: {
              id: COSMETIC_BADGE,
              data: { url: 'b.png' },
              type: 'Badge',
              source: 'Trophy',
              name: 'Badge',
            },
          },
        ],
      });
      expect(await readPostCollaboratorsViaKysely(kysely, prisma, POST_NO_M3D)).toStrictEqual({
        entity: { userId: COLLAB_B },
        collaborators: [],
      });
      expect(await readPostCollaboratorsViaKysely(kysely, prisma, POST_MISSING)).toBeNull();
    });
  });

  describe('a home block row', () => {
    it.each([
      ['a row with no source', HB_PLAIN],
      ['a row with a source', HB_SOURCE],
    ])('%s', async (_, id) => {
      const viaPrisma = await readHomeBlockViaPrisma(prisma, id);
      const viaKysely = await readHomeBlockViaKysely(kysely, id);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('a missing row: Prisma throws, Kysely answers null (the caller then runs the fallback)', async () => {
      await expect(readHomeBlockViaPrisma(prisma, HB_MISSING)).rejects.toThrow();
      expect(await readHomeBlockViaKysely(kysely, HB_MISSING)).toBeNull();
    });

    it('control: the row reads the fixture expected', async () => {
      expect(await readHomeBlockViaKysely(kysely, HB_PLAIN)).toStrictEqual({
        id: HB_PLAIN,
        metadata: { title: 'Hi', collection: { id: 3, limit: 8 } },
        type: 'Collection',
        userId: OWNER,
        sourceId: null,
      });
    });
  });

  describe('the unclaimed prize count', () => {
    it.each([
      ['claimed, voided and open prizes', VIEWER],
      ['one open prize', OWNER],
      ['no prizes', NO_ONE],
    ])('%s', async (_, userId) => {
      const viaPrisma = await countUnclaimedPrizesViaPrisma(prisma, userId);
      const viaKysely = await countUnclaimedPrizesViaKysely(kysely, userId);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: claimed and voided prizes are not counted', async () => {
      expect(await countUnclaimedPrizesViaKysely(kysely, VIEWER)).toBe(3);
      expect(await countUnclaimedPrizesViaKysely(kysely, NO_ONE)).toBe(0);
    });
  });

  describe("a model's version ids", () => {
    it.each([
      ['three versions', MODEL_A],
      ['two versions', MODEL_TAKEN_DOWN],
      ['no versions', MODEL_EMPTY],
    ])('%s', async (_, modelId) => {
      const viaPrisma = await readModelVersionIdsViaPrisma(prisma, modelId);
      const viaKysely = await readModelVersionIdsViaKysely(kysely, modelId);
      expect(byId(viaKysely)).toStrictEqual(byId(viaPrisma));
    });

    it('control: the ids are the fixture expected', async () => {
      expect(byId(await readModelVersionIdsViaKysely(kysely, MODEL_A))).toStrictEqual([
        { id: MV_A2 },
        { id: MV_A3 },
        { id: MV_A1 },
      ]);
    });
  });

  describe("a user's model reviews", () => {
    const cases: [string, UserResourceReviewInput][] = [
      ['by model', { modelId: MODEL_A, userId: VIEWER }],
      ['by model and version', { modelId: MODEL_A, modelVersionId: MV_A2, userId: VIEWER }],
      ['by version only', { modelVersionId: MV_TAKEN_DOWN, userId: VIEWER }],
      ['every review of the user', { userId: VIEWER }],
      ['another user', { modelId: MODEL_A, userId: OWNER }],
      ['none', { modelId: MODEL_EMPTY, userId: VIEWER }],
    ];

    it.each(cases)('%s', async (_, input) => {
      const viaPrisma = await readUserResourceReviewsViaPrisma(prisma, input);
      const viaKysely = await readUserResourceReviewsViaKysely(kysely, input);
      expect(byId(viaKysely)).toStrictEqual(byId(viaPrisma));
    });

    it('control: each filter selects the fixture rows expected, with every column', async () => {
      expect(
        byId(await readUserResourceReviewsViaKysely(kysely, { modelId: MODEL_A, userId: VIEWER }))
      ).toStrictEqual([
        {
          id: 6101,
          modelId: MODEL_A,
          modelVersionId: MV_A2,
          recommended: false,
          details: null,
          createdAt: new Date('2026-04-11T00:00:00.011Z'),
          exclude: true,
        },
        {
          id: 6103,
          modelId: MODEL_A,
          modelVersionId: MV_A1,
          recommended: true,
          details: '<p>good</p>',
          createdAt: new Date('2026-04-10T00:00:00.010Z'),
          exclude: false,
        },
      ]);
      const ids = async (input: UserResourceReviewInput) =>
        byId(await readUserResourceReviewsViaKysely(kysely, input)).map((r) => r.id);
      expect(await ids({ modelVersionId: MV_TAKEN_DOWN, userId: VIEWER })).toEqual([6102]);
      expect(await ids({ userId: VIEWER })).toEqual([6101, 6102, 6103]);
    });
  });

  describe("the download path's model version", () => {
    it.each([
      ['a published version', MV_A1],
      ['a gated version of a taken-down model', MV_TAKEN_DOWN],
      ['a NULL trained-words list', MV_NULL_WORDS],
      ['an orphaned version (its model is gone)', MV_ORPHAN],
      ['a missing version', MV_MISSING],
    ])('%s', async (_, id) => {
      const viaPrisma = await readModelVersionForFileViaPrisma(prisma, id);
      const viaKysely = await readModelVersionForFileViaKysely(kysely, id);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: the version and its model read the fixture expected', async () => {
      expect(await readModelVersionForFileViaKysely(kysely, MV_TAKEN_DOWN)).toStrictEqual({
        id: MV_TAKEN_DOWN,
        status: 'UnpublishedViolation',
        model: {
          id: MODEL_TAKEN_DOWN,
          name: 'Taken',
          type: 'Checkpoint',
          publishedAt: null,
          status: 'Unpublished',
          userId: COLLAB_A,
          mode: 'TakenDown',
          nsfw: false,
          availability: 'EarlyAccess',
          poi: true,
        },
        name: 'td',
        trainedWords: ['y'],
        createdAt: new Date('2026-04-05T00:00:00.000Z'),
        requireAuth: true,
        usageControl: 'ExternalGeneration',
      });
      expect((await readModelVersionForFileViaKysely(kysely, MV_A1))?.trainedWords).toStrictEqual([
        'alpha',
        'two words',
      ]);
      expect(await readModelVersionForFileViaKysely(kysely, MV_ORPHAN)).toBeNull();
    });
  });

  describe('the reaction.toggle image reads', () => {
    const keys: [string, ImageReactionKey][] = [
      ['a reaction', { userId: VIEWER, reaction: ReviewReactions.Heart, imageId: IMG_IN_POST }],
      [
        'another reaction',
        { userId: VIEWER, reaction: ReviewReactions.Like, imageId: IMG_IN_POST },
      ],
      ['no such reaction', { userId: VIEWER, reaction: ReviewReactions.Cry, imageId: IMG_IN_POST }],
      ['another user', { userId: OWNER, reaction: ReviewReactions.Cry, imageId: IMG_IN_POST }],
      ['a missing image', { userId: VIEWER, reaction: ReviewReactions.Like, imageId: IMG_MISSING }],
    ];

    it.each(keys)('the reaction id: %s', async (_, key) => {
      const viaPrisma = await readImageReactionIdViaPrisma(prisma, key);
      const viaKysely = await readImageReactionIdViaKysely(kysely, key);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it.each([
      ['an image', IMG_IN_POST],
      ['another image', IMG_NO_POST],
      ['a missing image', IMG_MISSING],
    ])('the nsfw level and owner: %s', async (_, id) => {
      const viaPrisma = await readImageNsfwLevelAndOwnerViaPrisma(prisma, id);
      const viaKysely = await readImageNsfwLevelAndOwnerViaKysely(kysely, id);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it.each([
      ['an image in a post', IMG_IN_POST],
      ['an image in no post', IMG_NO_POST],
    ])('the post id: %s', async (_, id) => {
      // See the header: the Prisma read keeps this one column of the whole row.
      const viaPrisma = await prisma.image.findUniqueOrThrow({
        where: { id },
        select: { postId: true },
      });
      const viaKysely = await readImagePostIdViaKysely(kysely, id);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: each read returns the fixture row expected', async () => {
      expect(
        await readImageReactionIdViaKysely(kysely, {
          userId: VIEWER,
          reaction: ReviewReactions.Heart,
          imageId: IMG_IN_POST,
        })
      ).toStrictEqual({ id: 6202 });
      expect(await readImageNsfwLevelAndOwnerViaKysely(kysely, IMG_IN_POST)).toStrictEqual({
        nsfwLevel: 4,
        userId: OWNER,
      });
      expect(await readImagePostIdViaKysely(kysely, IMG_IN_POST)).toStrictEqual({
        postId: POST_WITH_M3D,
      });
      expect(await readImagePostIdViaKysely(kysely, IMG_NO_POST)).toStrictEqual({ postId: null });
      // A missing image: Kysely answers undefined, so the caller runs the Prisma read, which throws.
      expect(await readImagePostIdViaKysely(kysely, IMG_MISSING)).toBeUndefined();
    });
  });

  describe("a model's meta", () => {
    it.each([
      ['a meta object', MODEL_A],
      ['an empty meta', MODEL_TAKEN_DOWN],
      ['a missing model', MODEL_MISSING],
    ])('%s', async (_, id) => {
      const viaPrisma = await readModelMetaViaPrisma(prisma, id);
      const viaKysely = await readModelMetaViaKysely(kysely, id);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: the meta reads the fixture expected', async () => {
      expect(await readModelMetaViaKysely(kysely, MODEL_A)).toStrictEqual({
        id: MODEL_A,
        meta: { showcaseCollectionId: 12, tags: ['x'] },
      });
      expect(await readModelMetaViaKysely(kysely, MODEL_MISSING)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------------------------
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

/** The quoted relation names a compiled statement reads FROM or JOINs. */
function relationsOf(sqlText: string): string[] {
  return [...sqlText.matchAll(/\b(?:from|join)\s+"(\w+)"/gi)].map((match) => match[1]);
}

async function compiledRelations(read: (db: never) => Promise<unknown>) {
  const harness = compileHarness();
  // The dummy driver returns no rows, so a read that requires one throws after compiling.
  await read(harness.db as never).catch(() => undefined);
  return harness.queries.map((query) => relationsOf(query.sql));
}

describe('hot reads 5: no statement reads a view', () => {
  const TABLES = [
    'KeyValue',
    'Post',
    'Model3D',
    'AnnouncementDismissal',
    'Announcement',
    'EntityCollaborator',
    'HomeBlock',
    'Prize',
    'ModelVersion',
    'ResourceReview',
    'Model',
    'ImageReaction',
    'Image',
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
      'UserStat',
      'User',
    ]);
  });

  // The collaborator read's users go through Prisma (not compiled here), so its Kysely ledger is
  // the one statement over Post and EntityCollaborator.
  it.each<[string, (db: never) => Promise<unknown>, string[][]]>([
    ['a KeyValue row', (db) => readKeyValueViaKysely(db, 'k'), [['KeyValue']]],
    ["a post's Model3D", (db) => readPostModel3dViaKysely(db, 1), [['Post', 'Model3D']]],
    [
      'the dismissed announcement ids',
      (db) =>
        readDismissedAnnouncementIdsViaKysely(db, { userId: 1, now: NOW, domain: DomainColor.red }),
      [['AnnouncementDismissal', 'Announcement']],
    ],
    [
      "a post's collaborators",
      (db) => readPostCollaboratorsViaKysely(db, undefined as never, 1),
      [['Post', 'EntityCollaborator']],
    ],
    ['a home block', (db) => readHomeBlockViaKysely(db, 1), [['HomeBlock']]],
    ['the unclaimed prize count', (db) => countUnclaimedPrizesViaKysely(db, 1), [['Prize']]],
    ["a model's version ids", (db) => readModelVersionIdsViaKysely(db, 1), [['ModelVersion']]],
    [
      "a user's model reviews",
      (db) => readUserResourceReviewsViaKysely(db, { modelId: 1, userId: 2 }),
      [['ResourceReview']],
    ],
    [
      "the download path's model version",
      (db) => readModelVersionForFileViaKysely(db, 1),
      [['ModelVersion', 'Model']],
    ],
    [
      'an image reaction id',
      (db) =>
        readImageReactionIdViaKysely(db, { userId: 1, reaction: ReviewReactions.Like, imageId: 2 }),
      [['ImageReaction']],
    ],
    ["an image's nsfw level", (db) => readImageNsfwLevelAndOwnerViaKysely(db, 1), [['Image']]],
    ["an image's post id", (db) => readImagePostIdViaKysely(db, 1), [['Image']]],
    ["a model's meta", (db) => readModelMetaViaKysely(db, 1), [['Model']]],
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
