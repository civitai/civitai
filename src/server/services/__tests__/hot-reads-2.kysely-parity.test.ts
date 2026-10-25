import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';
import { createKyselyClients } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { Kysely, PostgresDialect, type CompiledQuery } from 'kysely';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadParitySchema } from '~/server/db/__tests__/parity-schema';
import { modelWithDetailsSelect } from '~/server/selectors/model.selector';
import {
  readModelWithDetailsViaKysely,
  type ModelWithDetails,
} from '~/server/services/model-details.reads';
import {
  readUserCreatorViaKysely,
  readUserCreatorViaPrisma,
  type UserCreatorRead,
  type UserCreatorWhere,
} from '~/server/services/user-creator.reads';
import { getImageThread } from '@civitai/db-queries/hot-reads';
import { readImageTagsViaKysely, readImageTagsViaPrisma } from '~/server/redis/image-tags.reads';

/**
 * Parity gate for the reads behind `kysely-hot-reads-2`: the model page's `modelWithDetailsSelect`
 * read, the creator card, the image tags behind `imageTagsCache` and an image's comment thread. Both paths run against the same rows in the same database and must
 * return the same value, `toStrictEqual`: timestamps as UTC Dates, `licensingFee` as a
 * `Prisma.Decimal`, enums as strings, JSON decoded, a missing to-one relation as `null`, an empty
 * to-many as `[]`.
 *
 * The creator card's Prisma side is `readUserCreatorViaPrisma`, the function the service runs. The
 * model's Prisma side is `getModel`'s own `findFirst` with the same imported select (getModel itself
 * picks its client through the lag helpers).
 *
 * Relations no Prisma read orders (licenses, links, cosmetics, files, hashes, recommended
 * resources) are compared after sorting by key: neither path promises their order. The versions
 * are compared in the order both read them, `index asc`.
 *
 * Runs in CI: the `unit` job points KYSELY_HOT_READS_2_PARITY_DATABASE_URL at its throwaway
 * Postgres service, and the last test below fails if that wiring is lost, so the suite cannot skip
 * itself there unnoticed. Locally, KYSELY_PARITY_DATABASE_URL (the other parity suites' variable)
 * works too, and must point at a THROWAWAY database: the suite drops and recreates the
 * `hot_reads_2_parity` schema. It deliberately does NOT fall back to `DATABASE_URL`.
 */
const parityUrl =
  process.env.KYSELY_HOT_READS_2_PARITY_DATABASE_URL ?? process.env.KYSELY_PARITY_DATABASE_URL;
const SCHEMA = 'hot_reads_2_parity';

const schemaStatements = loadParitySchema(
  resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/hot-reads-2-parity-schema.sql')
);

const withSchema = (url: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set('schema', SCHEMA);
  return parsed.toString();
};

const byKey = <T>(rows: T[], key: (row: T) => string | number) =>
  [...rows].sort((a, b) => String(key(a)).localeCompare(String(key(b))));

function sortModel(model: ModelWithDetails | null) {
  if (!model) return model;
  return {
    ...model,
    licenses: byKey(model.licenses, (l) => l.id),
    modelVersions: model.modelVersions.map((version) => ({
      ...version,
      files: byKey(
        version.files.map((file) => ({ ...file, hashes: byKey(file.hashes, (h) => h.type) })),
        (f) => f.id
      ),
      recommendedResources: byKey(version.recommendedResources, (r) => r.id),
    })),
  };
}

function sortCreator(read: UserCreatorRead) {
  if (!read) return read;
  return {
    ...read,
    user: {
      ...read.user,
      links: byKey(read.user.links, (l) => l.url),
      cosmetics: byKey(read.user.cosmetics, (c) => c.cosmetic.id),
    },
  };
}

// Distinct ids per table, and none equal to a count or another id.
const CREATOR = 1101;
const BARE = 1102;
const NAMELESS = 1103;
const DELETED = 1104;
const SYSTEM = -1;
const PICTURE = 2101;
const MODEL = 3101;
const MODEL_BARE = 3102;
const MODEL_OF_DELETED = 3103;
const DRAFT_MODEL = 3104;
const MISSING = 3999;
const V_FULL = 4101;
const V_EMPTY = 4102;
const V_TRAINED = 4103;
const V_OTHER_MODEL = 4104;
const FILE_A = 5101;
const FILE_B = 5102;
const FILE_PURGED = 5103;
const FILE_REPLACED = 5104;
const FILE_OTHER_MODEL = 5105;
const LICENSE_A = 6101;
const LICENSE_B = 6102;
const COSMETIC_A = 7101;
const COSMETIC_B = 7102;
const COSMETIC_UNEQUIPPED = 7103;
const COSMETIC_ON_ENTITY = 7104;
const IMAGE_TWO = 2102;
const ALICE_VOTER = 1201;
const BOB_VOTER = 1202;
const IMAGE_UNTAGGED = 2103;
const THREAD_LOCKED = 9301;
const THREAD_OPEN = 9302;
const THREAD_OF_MODEL = 9303;

describe.skipIf(!parityUrl)('hot reads 2: Kysely returns exactly what Prisma returned', () => {
  const prisma = new PrismaClient({ datasourceUrl: parityUrl && withSchema(parityUrl) });
  const { db } = createKyselyClients<DB>({ connectionString: parityUrl, singleClient: true });
  const kysely = db.withSchema(SCHEMA);
  const t = (table: string) => `"${SCHEMA}"."${table}"`;

  beforeAll(async () => {
    for (const statement of schemaStatements) await prisma.$executeRawUnsafe(statement);

    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('User')} (id, username, image, "createdAt", "deletedAt", muted, "bannedAt",
        "excludeFromLeaderboards", "profilePictureId", settings, "publicSettings") VALUES
        (${CREATOR}, 'creator', 'avatar.png', '2025-05-06 07:08:09.123', NULL, true,
          '2026-01-02 03:04:05.678', true, ${PICTURE}, '{"creatorShop": {"enabled": true}}',
          '{"showcase": [1, 2]}'),
        (${BARE}, 'bare', NULL, '2024-03-04 05:06:07.891', NULL, false, NULL, false, NULL, NULL, NULL),
        (${NAMELESS}, NULL, NULL, '2024-03-05 05:06:07.891', NULL, false, NULL, false, NULL, '{}', '{}'),
        (${DELETED}, 'gone', NULL, '2024-03-06 05:06:07.891', '2026-02-03 04:05:06.789', false,
          NULL, false, NULL, '{}', '{}'),
        (${SYSTEM}, 'civitai', NULL, '2020-01-01 00:00:00.000', NULL, false, NULL, false, NULL,
          '{}', '{}')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('UserRank')} VALUES (${CREATOR}, 9, 'overall', 'Top creator', 'gold-frame')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('UserMetric')} ("userId", timeframe, "followingCount", "followerCount",
        "reactionCount", "hiddenCount", "uploadCount", "reviewCount", "answerCount",
        "answerAcceptCount") VALUES
        (${CREATOR}, 'AllTime', 1, 34, 36, 2, 31, 3, 4, 5),
        (${CREATOR}, 'Day', 901, 902, 903, 904, 905, 906, 907, 908),
        (${NAMELESS}, 'AllTime', 0, 7, 0, 0, 0, 0, 0, 0)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('UserLink')} VALUES
        (8101, ${CREATOR}, 'https://example.com/b', 'Social'),
        (8102, ${CREATOR}, 'https://example.com/a', 'Sponsorship'),
        (8103, ${BARE}, 'https://example.com/bare', 'Other')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Cosmetic')} VALUES
        (${COSMETIC_A}, 'Badge A', 'first', 'Badge', 'Event', '{"url": "a.png"}'),
        (${COSMETIC_B}, 'Plate B', NULL, 'NamePlate', 'Purchase', '{"color": "red"}'),
        (${COSMETIC_UNEQUIPPED}, 'Unequipped', NULL, 'Badge', 'Claim', '{}'),
        (${COSMETIC_ON_ENTITY}, 'On a model', NULL, 'ContentDecoration', 'Trophy', '{}')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('UserCosmetic')} ("userId", "cosmeticId", "claimKey", "equippedAt",
        "equippedToId", data) VALUES
        (${CREATOR}, ${COSMETIC_B}, 'claimed', '2026-03-01 00:00:00.000', NULL, NULL),
        (${CREATOR}, ${COSMETIC_A}, 'claimed', '2026-03-02 00:00:00.000', NULL, '{"lights": 3}'),
        (${CREATOR}, ${COSMETIC_UNEQUIPPED}, 'claimed', NULL, NULL, '{}'),
        (${CREATOR}, ${COSMETIC_ON_ENTITY}, 'claimed', '2026-03-03 00:00:00.000', ${MODEL}, '{}')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Image')} (id, name, url, "userId", hash, height, width, type, metadata,
        "nsfwLevel", ingestion) VALUES
        (${PICTURE}, NULL, 'picture.png', ${CREATOR}, 'Uabc', 480, 640, 'image',
          '{"size": 1234}', 1, 'Scanned')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Model')} (id, name, description, type, "updatedAt", nsfw, poi, minor,
        "userId", status, "publishedAt", meta, "deletedAt", "deletedBy", "checkpointType",
        "uploadType", locked, mode, availability, "nsfwLevel", "lockedProperties", "sfwOnly",
        "isOfficial", "sfwName", "sfwDescription", "coverImageId", "sfwCoverImageId",
        "allowNoCredit", "allowCommercialUse", "allowDerivatives", "allowDifferentLicense") VALUES
        (${MODEL}, 'Full model', '<p>about</p>', 'Checkpoint', '2026-04-05 06:07:08.912', true,
          false, false, ${CREATOR}, 'Published', '2026-04-01 01:02:03.456',
          '{"commentsLocked": false, "imageModeration": true}', NULL, NULL, 'Merge', 'Trained',
          true, NULL, 'EarlyAccess', 28, '{name,description}', true, true, 'Safe name',
          'safe about', 9101, 9102, false, '{Image,RentCivit,Sell}', false, true),
        (${MODEL_BARE}, 'Bare model', NULL, 'LORA', '2026-04-06 06:07:08.912', false, false, false,
          ${BARE}, 'Draft', NULL, '{}', '2026-04-07 00:00:00.000', ${BARE}, NULL, 'Created',
          false, NULL, 'Public', 0, '{}', false, false, NULL, NULL, NULL, NULL, true, '{}', true,
          false),
        (${MODEL_OF_DELETED}, 'Deleted user model', NULL, 'VAE', '2026-04-08 06:07:08.912', false,
          false, false, ${DELETED}, 'Published', NULL, '{}', NULL, NULL, NULL, 'Created', false,
          'TakenDown', 'Public', 1, '{}', false, false, NULL, NULL, NULL, NULL, true, '{None}', true,
          true),
        (${DRAFT_MODEL}, 'Draft by creator', NULL, 'LORA', '2026-04-09 06:07:08.912', false, false,
          false, ${CREATOR}, 'Draft', NULL, '{}', NULL, NULL, NULL, 'Created', false, NULL,
          'Public', 0, '{}', false, false, NULL, NULL, NULL, NULL, true, '{}', true, true)
    `);
    // "ModelReportStat" is a view over these: two ownership reports in processing, one NSFW.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Report')} (id, reason, status) VALUES
        (9601, 'Ownership', 'Processing'), (9602, 'Ownership', 'Processing'), (9603, 'NSFW', 'Pending')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelReport')} ("modelId", "reportId") VALUES
        (${MODEL}, 9601), (${MODEL}, 9602), (${MODEL}, 9603)
    `);
    // Also the base of "UserStat": the published model counts, the draft does not.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelMetric')} ("modelId", "userId", status, availability, "downloadCount",
        "commentCount", "collectedCount", "imageCount", "tippedAmountCount", "generationCount",
        "thumbsUpCount", "thumbsDownCount") VALUES
        (${MODEL}, ${CREATOR}, 'Published', 'EarlyAccess', 41, 42, 43, 44, 45, 46, 47, 48),
        (${DRAFT_MODEL}, ${CREATOR}, 'Draft', 'Public', 500, 0, 0, 0, 0, 500, 500, 0)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('License')} VALUES
        (${LICENSE_A}, 'License A', 'https://example.com/license-a'),
        (${LICENSE_B}, 'License B', 'https://example.com/license-b')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('_LicenseToModel')} ("A", "B") VALUES
        (${LICENSE_B}, ${MODEL}), (${LICENSE_A}, ${MODEL}), (${LICENSE_A}, ${MODEL_OF_DELETED})
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelVersion')} (id, "index", name, description, "modelId", "trainedWords",
        steps, epochs, "clipSkip", "createdAt", "updatedAt", "publishedAt", status,
        "trainingStatus", "trainingDetails", inaccurate, "baseModel", "baseModelType", meta,
        "requireAuth", settings, availability, "nsfwLevel", "uploadType", "usageControl", flags,
        "generatorLoaded", "licensingFee") VALUES
        (${V_FULL}, 2, 'v-full', 'full version', ${MODEL}, '{alpha,beta}', 1000, 10, 2,
          '2026-04-01 00:00:00.111', '2026-04-02 00:00:00.222', '2026-04-03 00:00:00.333',
          'Published', NULL, NULL, true, 'SDXL 1.0', 'Standard', '{"earlyAccessConfig": {"timeframe": 3}}',
          true, '{"strength": 0.7}', 'EarlyAccess', 4, 'Created', 'Generation', 5, true, 12.50),
        (${V_EMPTY}, 0, 'v-empty', NULL, ${MODEL}, '{}', NULL, NULL, NULL,
          '2026-04-04 00:00:00.444', '2026-04-05 00:00:00.555', NULL, 'Draft', NULL, NULL, false,
          'Flux.1 D', 'Inpainting', '{}', false, NULL, 'Public', 0, 'Created', 'Download', 0,
          false, NULL),
        (${V_TRAINED}, 1, 'v-trained', 'trained', ${MODEL}, '{gamma}', 200, 4, NULL,
          '2026-04-06 00:00:00.666', '2026-04-07 00:00:00.777', NULL, 'Training', 'Approved',
          '{"type": "Character", "params": {"epochs": 4}}', false, 'SD 1.5', 'Standard', '{}',
          false, NULL, 'Private', 1, 'Trained', 'InternalGeneration', 1, false, 0.05),
        (${V_OTHER_MODEL}, 0, 'v-other', NULL, ${MODEL_OF_DELETED}, '{}', NULL, NULL, NULL,
          '2026-04-08 00:00:00.888', '2026-04-09 00:00:00.999', NULL, 'Published', NULL, NULL,
          false, 'SD 1.5', 'Standard', '{}', false, NULL, 'Public', 1, 'Created', 'Download', 0,
          false, NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelVersionMetric')} VALUES
        (${V_FULL}, 51, 52, 53, 54, 55), (${V_OTHER_MODEL}, 61, 62, 63, 64, 65)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelFile')} (id, name, "overrideName", url, "sizeKB", type,
        "modelVersionId", "pickleScanResult", "pickleScanMessage", "virusScanResult",
        "virusScanMessage", "scannedAt", metadata, visibility, "dataPurged", "replacedAt") VALUES
        (${FILE_B}, 'b.safetensors', 'renamed.safetensors', 'https://files/b', 2048.5, 'Model',
          ${V_FULL}, 'Success', 'clean', 'Success', NULL, '2026-04-10 10:11:12.131',
          '{"fp": "fp16", "size": "pruned"}', 'Public', false, NULL),
        (${FILE_A}, 'a.yaml', NULL, 'https://files/a', 1.25, 'Config', ${V_FULL}, 'Pending', NULL,
          'Danger', 'flagged', NULL, NULL, 'Sensitive', false, NULL),
        (${FILE_PURGED}, 'purged.ckpt', NULL, 'https://files/p', 3, 'Model', ${V_FULL},
          'Success', NULL, 'Success', NULL, NULL, NULL, 'Public', true, NULL),
        (${FILE_REPLACED}, 'old.ckpt', NULL, 'https://files/o', 4, 'Model', ${V_TRAINED},
          'Success', NULL, 'Success', NULL, '2026-04-11 01:00:00.000', '{"format": "PickleTensor"}',
          'Public', false, '2026-04-11 00:00:00.000'),
        (${FILE_OTHER_MODEL}, 'other.ckpt', NULL, 'https://files/x', 5, 'Model', ${V_OTHER_MODEL},
          'Success', NULL, 'Success', NULL, NULL, NULL, 'Private', false, NULL)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('ModelFileHash')} VALUES
        (${FILE_B}, 'SHA256', 'ABCDEF0123'), (${FILE_B}, 'AutoV2', 'ABCDEF01'),
        (${FILE_PURGED}, 'SHA256', 'PURGED'), (${FILE_OTHER_MODEL}, 'BLAKE3', 'OTHER')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('EcosystemCheckpoints')} VALUES (${V_FULL}, 'ecosystem')
    `);
    // "GenerationCoverage" is a view over these: V_FULL is covered as an ecosystem checkpoint,
    // V_TRAINED by the auction rule with a live non-safetensor file (covered, not coveredNext),
    // V_EMPTY's base model is not generatable (no row), and MODEL_OF_DELETED is taken down.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('GenerationBaseModel')} VALUES ('SD 1.5'), ('SDXL 1.0')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('CoveredCheckpoint')} VALUES (${MODEL}, ${V_TRAINED})
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('RecommendedResource')} VALUES
        (9201, ${V_OTHER_MODEL}, ${V_FULL}, '{"strength": 0.5, "isLinkedComponent": false}'),
        (9202, ${V_TRAINED}, ${V_FULL}, NULL),
        (9203, ${V_FULL}, ${V_OTHER_MODEL}, '{}')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Tag')} (id, name, type, "nsfwLevel", unlisted) VALUES
        (9811, 'tie-a', 'Moderation', 16, false), (9812, 'tie-b', 'UserGenerated', 4, false),
        (9813, 'low', 'Label', 1, false), (9814, 'only', 'System', 2, false),
        (9815, 'unlisted', 'Label', 1, true), (9816, 'disabled', 'Label', 1, false),
        (9817, 'vote-only', 'Label', 1, false)
    `);
    // "ImageTag" is a view over these. score = confidence / 10 + the vote sum, so 9811 (7 + 2)
    // and 9812 (9 + 0) tie at 9 above 9814 (7) and 9813 (5); 9815's tag is unlisted, 9816 is
    // disabled, and 9817 has votes but no details row: none of the three is a row.
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('TagsOnImageDetails')} ("imageId", "tagId", source, automated, disabled,
        "needsReview", confidence) VALUES
        (${PICTURE}, 9813, 'WD14', true, false, false, 50),
        (${PICTURE}, 9812, 'User', false, false, true, 90),
        (${PICTURE}, 9811, 'Hive', false, false, false, 70),
        (${IMAGE_TWO}, 9814, 'Computed', true, false, false, 75),
        (${PICTURE}, 9815, 'WD14', true, false, false, 99),
        (${PICTURE}, 9816, 'WD14', true, true, false, 99)
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('TagsOnImageVote')} ("tagId", "imageId", "userId", vote, "createdAt") VALUES
        (9812, ${PICTURE}, ${ALICE_VOTER}, 1, '2026-05-06 07:08:09.101'),
        (9812, ${PICTURE}, ${BOB_VOTER}, -1, '2026-05-06 08:00:00.000'),
        (9811, ${PICTURE}, ${ALICE_VOTER}, 1, '2026-05-07 07:08:09.202'),
        (9811, ${PICTURE}, ${BOB_VOTER}, 1, '2026-05-01 00:00:00.000'),
        (9817, ${IMAGE_TWO}, ${ALICE_VOTER}, 1, '2026-05-02 00:00:00.000')
    `);
    await prisma.$executeRawUnsafe(`
      INSERT INTO ${t('Thread')} (id, locked, "imageId", "modelId") VALUES
        (${THREAD_LOCKED}, true, ${PICTURE}, NULL),
        (${THREAD_OPEN}, false, ${IMAGE_TWO}, NULL),
        (${THREAD_OF_MODEL}, false, NULL, ${MODEL})
    `);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await db.destroy();
  });

  const prismaModel = (id: number) =>
    prisma.model.findFirst({ where: { id }, select: modelWithDetailsSelect });

  describe('the model page (modelWithDetailsSelect)', () => {
    it.each([
      ['a model with every relation filled', MODEL],
      ['a model with no rank, report stats, licenses, metrics or versions', MODEL_BARE],
      ['a model whose creator is deleted', MODEL_OF_DELETED],
      ['a missing model', MISSING],
    ])('%s', async (_, id) => {
      const viaPrisma = await prismaModel(id);
      const viaKysely = await readModelWithDetailsViaKysely(kysely, id);
      expect(sortModel(viaKysely)).toStrictEqual(sortModel(viaPrisma));
    });

    it('control: the full model exercises every relation, so its equality is not vacuous', async () => {
      const model = await prismaModel(MODEL);
      expect(model?.licenses).toHaveLength(2);
      expect(model?.reportStats).toEqual({ ownershipProcessing: 2 });
      expect(model?.user.rank).toEqual({ leaderboardRank: 9 });
      expect(model?.metrics).toHaveLength(1);
      expect(model?.modelVersions.map((v) => v.id)).toEqual([V_EMPTY, V_TRAINED, V_FULL]);
      const full = model?.modelVersions.find((v) => v.id === V_FULL);
      expect(full?.licensingFee).toBeInstanceOf(Prisma.Decimal);
      expect(full?.files.map((f) => f.id).sort()).toEqual([FILE_A, FILE_B]);
      expect(full?.files.find((f) => f.id === FILE_B)?.hashes).toHaveLength(2);
      expect(full?.files.find((f) => f.id === FILE_B)?.scannedAt).toBeInstanceOf(Date);
      expect(full?.recommendedResources).toHaveLength(2);
      expect(full?.generationCoverage).toEqual({ covered: true, coveredNext: true });
      const trained = model?.modelVersions.find((v) => v.id === V_TRAINED);
      expect(trained?.generationCoverage).toEqual({ covered: true, coveredNext: false });
      const empty = model?.modelVersions.find((v) => v.id === V_EMPTY);
      expect(empty?.generationCoverage).toBeNull();
      expect(full?.metrics).toHaveLength(1);
      const bare = await prismaModel(MODEL_BARE);
      expect(bare?.user.rank).toBeNull();
      expect(bare?.reportStats).toBeNull();
      expect(bare?.modelVersions).toEqual([]);
    });
  });

  describe('the creator card', () => {
    it.each<[string, UserCreatorWhere]>([
      ['by id, every relation filled', { id: CREATOR }],
      ['by username', { username: 'creator' }],
      ['by id and username together', { id: CREATOR, username: 'creator' }],
      ['by id with a mismatched username', { id: CREATOR, username: 'bare' }],
      ['a user with no relations', { id: BARE }],
      ['a user with no username', { id: NAMELESS }],
      ['a deleted user', { id: DELETED }],
      ['the system user by id', { id: SYSTEM }],
      ['the system user by username', { username: 'civitai' }],
      ['a missing user', { id: MISSING }],
      ['an explicitly undefined username', { id: BARE, username: undefined }],
    ])('%s', async (_, where) => {
      const viaPrisma = await readUserCreatorViaPrisma(prisma, where);
      const viaKysely = await readUserCreatorViaKysely(kysely, where);
      expect(sortCreator(viaKysely)).toStrictEqual(sortCreator(viaPrisma));
    });

    it('control: the full card exercises every relation, so its equality is not vacuous', async () => {
      const read = await readUserCreatorViaPrisma(prisma, { id: CREATOR });
      expect(read?.modelCount).toBe(1);
      expect(read?.user.links).toHaveLength(2);
      expect(read?.user.cosmetics.map((c) => c.cosmetic.id).sort()).toEqual([
        COSMETIC_A,
        COSMETIC_B,
      ]);
      // From the "UserStat" view: the AllTime row only, the published model only.
      expect(read?.user.stats).toEqual({
        downloadCountAllTime: 41,
        thumbsUpCountAllTime: 47,
        followerCountAllTime: 34,
        reactionCountAllTime: 36,
        uploadCountAllTime: 31,
        generationCountAllTime: 46,
      });
      expect(read?.user.rank).not.toBeNull();
      expect(read?.user.profilePicture?.id).toBe(PICTURE);
      expect(read?.user.bannedAt).toBeInstanceOf(Date);
      const bare = await readUserCreatorViaPrisma(prisma, { id: BARE });
      expect(bare).toMatchObject({ modelCount: 0 });
      expect(bare?.user).toMatchObject({ stats: null, rank: null, profilePicture: null });
    });
  });

  describe('the image tags (imageTagsCache)', () => {
    it.each([
      ['several images, one untagged', [PICTURE, IMAGE_TWO, IMAGE_UNTAGGED]],
      ['an untagged image', [IMAGE_UNTAGGED]],
      ['no images', []],
    ])('%s, in the same order', async (_, ids) => {
      const viaPrisma = await readImageTagsViaPrisma(prisma, ids);
      const viaKysely = await readImageTagsViaKysely(kysely, ids);
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: the order is score desc, then tagId asc, and the rows carry Dates', async () => {
      const rows = await readImageTagsViaPrisma(prisma, [PICTURE, IMAGE_TWO]);
      expect(rows.map((row) => row.tagId)).toEqual([9811, 9812, 9814, 9813]);
      expect(rows[0].lastUpvote).toBeInstanceOf(Date);
    });
  });

  describe("an image's comment thread", () => {
    it.each([
      ['a locked thread', PICTURE],
      ['an open thread', IMAGE_TWO],
      ['no thread', IMAGE_UNTAGGED],
    ])('%s', async (_, imageId) => {
      const viaPrisma = await prisma.thread.findUnique({
        where: { imageId },
        select: { id: true, locked: true },
      });
      const viaKysely = (await getImageThread(kysely, imageId)) ?? null;
      expect(viaKysely).toStrictEqual(viaPrisma);
    });

    it('control: the fixture threads are found', async () => {
      expect(await getImageThread(kysely, PICTURE)).toEqual({ id: THREAD_LOCKED, locked: true });
    });
  });
});

/** One scan node of an EXPLAIN (FORMAT JSON) plan, with the conditions it filters by. */
type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const CONDITION_KEYS = ['Index Cond', 'Filter', 'Recheck Cond', 'TID Cond'];
function scansOf(node: PlanNode, relation: string, alias: string): string[] {
  const own =
    node['Relation Name'] === relation && node['Alias'] === alias
      ? [CONDITION_KEYS.map((key) => String(node[key] ?? '')).join(' ')]
      : [];
  return [...own, ...(node.Plans ?? []).flatMap((child) => scansOf(child, relation, alias))];
}

/**
 * The base-table scan inside each VIEW that must carry the lookup key when the view is filtered by
 * it as a parameter, and does NOT when the view is reached through a join (Postgres cannot push a
 * join key through the view's GROUP BY / UNION, so it computes the view for every key).
 */
const VIEW_KEY_SCANS: Record<string, { relation: string; alias: string }> = {
  UserStat: { relation: 'UserMetric', alias: 'um' },
  ModelReportStat: { relation: 'Model', alias: 'm' },
  GenerationCoverage: { relation: 'ModelVersion', alias: 'mv' },
  ImageTag: { relation: 'TagsOnImageDetails', alias: 'toi_1' },
};

describe.skipIf(!parityUrl)(
  'hot reads 2: every view is read by its key, not through a join',
  () => {
    const pool = new Pool({ connectionString: parityUrl });
    const statements: CompiledQuery[] = [];
    const logged = new Kysely<DB>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === 'query') statements.push(event.query);
      },
    }).withSchema(SCHEMA);

    afterAll(async () => {
      await logged.destroy();
    });

    /** Runs one flag-ON read, then EXPLAINs every statement it issued that reads a view. */
    async function viewScans(read: () => Promise<unknown>) {
      statements.length = 0;
      await read();
      const scans: { view: string; conditions: string[] }[] = [];
      for (const statement of statements) {
        for (const view of Object.keys(VIEW_KEY_SCANS)) {
          if (!statement.sql.includes(`"${view}"`)) continue;
          const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${statement.sql}`, [
            ...statement.parameters,
          ]);
          const plan = (rows[0]['QUERY PLAN'] as { Plan: PlanNode }[])[0].Plan;
          const { relation, alias } = VIEW_KEY_SCANS[view];
          scans.push({ view, conditions: scansOf(plan, relation, alias) });
        }
      }
      return scans;
    }

    it.each<[string, () => Promise<unknown>, Record<string, string>]>([
      [
        'the creator card by USERNAME (the stats view by the resolved id)',
        () => readUserCreatorViaKysely(logged, { username: 'creator' }),
        { UserStat: String(CREATOR) },
      ],
      [
        'the creator card by id',
        () => readUserCreatorViaKysely(logged, { id: CREATOR }),
        { UserStat: String(CREATOR) },
      ],
      [
        'the model page (report stats and generation coverage by the model id)',
        () => readModelWithDetailsViaKysely(logged, MODEL),
        { ModelReportStat: String(MODEL), GenerationCoverage: String(MODEL) },
      ],
      [
        'the image tags (by the image ids)',
        () => readImageTagsViaKysely(logged, [PICTURE, IMAGE_TWO]),
        { ImageTag: String(PICTURE) },
      ],
    ])('%s', async (_, read, keys) => {
      const scans = await viewScans(read);
      // Positive control: each expected view was read, and its key scan is in the plan, so the key
      // assertion below cannot pass on an empty set.
      expect([...new Set(scans.map((scan) => scan.view))].sort()).toEqual(Object.keys(keys).sort());
      for (const { view, conditions } of scans) {
        expect(
          conditions.length,
          `${view}: no ${VIEW_KEY_SCANS[view].alias} scan in the plan`
        ).toBeGreaterThan(0);
        for (const condition of conditions)
          expect(condition, `${view} scan does not filter by the key`).toContain(keys[view]);
      }
    });
  }
);

// GitHub Actions only: the `unit` job there is the one wired with the database.
it.runIf(process.env.GITHUB_ACTIONS === 'true')('runs in CI: the parity database is wired', () => {
  expect(parityUrl).toBeTruthy();
});
