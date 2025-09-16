import { faker } from '@faker-js/faker';
import dayjs from '~/shared/utils/dayjs';
import { capitalize, pull, range, without } from 'lodash-es';
import type { DatabaseError } from 'pg';
import format from 'pg-format';
// import type { DatabaseError } from 'pg-protocol/src/messages';
import { clickhouse } from '~/server/clickhouse/client';
import type { BaseModelType } from '~/server/common/constants';
import { constants } from '~/server/common/constants';
import { NotificationCategory } from '~/server/common/enums';
import { notifDbWrite } from '~/server/db/notifDb';
import { pgDbWrite } from '~/server/db/pgDb';
import { notificationProcessors } from '~/server/notifications/utils.notifications';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { getChatHash, getUsersFromHash } from '~/server/utils/chat';
import { baseModels } from '~/shared/constants/base-model.constants';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import {
  ArticleEngagementType,
  Availability,
  BountyEntryMode,
  BountyMode,
  BountyType,
  ChangelogType,
  ChatMemberStatus,
  ChatMessageType,
  CheckpointType,
  CollectionType,
  EntityMetric_MetricType_Type,
  ImageEngagementType,
  ImageGenerationProcess,
  ModelEngagementType,
  ModelFileVisibility,
  ModelModifier,
  ModelStatus,
  ModelType,
  ModelUploadType,
  ModelVersionEngagementType,
  NsfwLevel,
  ReviewReactions,
  ScanResultCode,
  TagEngagementType,
  TagType,
  ToolType,
  TrainingStatus,
  UserEngagementType,
} from '~/shared/utils/prisma/enums';
import { isDefined } from '~/utils/type-guards';
import {
  checkLocalDb,
  deleteRandomJobQueueRows,
  generateRandomName,
  insertRows,
  randPrependBad,
} from './utils';
// import { fetchBlob } from '~/utils/file-utils';

// Usage: npx tsx ./scripts/local-dev/gen_seed.ts --rows=1000
// OR make bootstrap-db ROWS=1000
const numRows = Number(process.argv.find((arg) => arg.startsWith('--rows='))?.split('=')[1]) || 500;
const truncQueue =
  process.argv.find((arg) => arg.startsWith('--trunc='))?.split('=')[1] !== 'false';

faker.seed(1337);
const randw = faker.helpers.weightedArrayElement;
const rand = faker.helpers.arrayElement;
const fbool = faker.datatype.boolean;

// const getUrlAsFile = async (url: string) => {
//   const blob = await fetchBlob(url);
//   if (!blob) return;
//   const lastIndex = url.lastIndexOf('/');
//   const name = url.substring(lastIndex + 1);
//   return new File([blob], name, { type: blob.type });
// };

// TODO fix tables ownership from doadmin to civitai

// TODO seed logicalDb

const setSerialNotif = async (table: string) => {
  // language=text
  const query = `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), coalesce(max(id)+1, 1), false) FROM %I`;

  try {
    await notifDbWrite.query(format(query, table));
    console.log(`\t-> ✔️ Set ID sequence`);
  } catch (error) {
    const e = error as DatabaseError;
    console.log(`\t-> ❌  Error setting ID sequence`);
    console.log(`\t-> ${e.message}`);
    if (e.detail) console.log(`\t-> Detail: ${e.detail}`);
    if (e.where) console.log(`\t-> where: ${e.where}`);
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const insertNotifRows = async (table: string, data: any[][]) => {
  if (!data.length) {
    console.log(`No rows to insert. Skipping ${table}.`);
    return [];
  }

  console.log(`Inserting ${data.length} rows into ${table}`);

  // language=text
  const query = 'INSERT INTO %I VALUES %L ON CONFLICT DO NOTHING RETURNING ID';

  try {
    const ret = await notifDbWrite.query<{ id: number }>(format(query, table, data));

    if (ret.rowCount === data.length) console.log(`\t-> ✔️ Inserted ${ret.rowCount} rows`);
    else if (ret.rowCount === 0) console.log(`\t-> ⚠️ Inserted 0 rows`);
    else console.log(`\t-> ⚠️ Only inserted ${ret.rowCount ?? 'unk'} of ${data.length} rows`);

    await setSerialNotif(table);

    return ret.rows.map((r) => r.id);
  } catch (error) {
    const e = error as DatabaseError;
    console.log(`\t-> ❌  ${e.message}`);
    if (e.detail) console.log(`\t-> Detail: ${e.detail}`);
    if (e.where) console.log(`\t-> where: ${e.where}`);
    return [];
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const insertClickhouseRows = async (table: string, data: any[][]) => {
  if (!data.length) {
    console.log(`No rows to insert. Skipping ${table}.`);
    return [];
  }
  if (!clickhouse) {
    console.log(`No clickhouse client. Skipping ${table}.`);
    return [];
  }

  console.log(`Inserting ${data.length} rows into ${table}`);

  try {
    const ret = await clickhouse.insert({
      table,
      values: data,
      clickhouse_settings: {
        date_time_input_format: 'best_effort',
      },
    });

    // TODO how to get the response here?
    // if (ret.length === data.length) console.log(`\t-> ✔️ Inserted ${ret.length} rows`);
    // else if (ret.length === 0) console.log(`\t-> ⚠️ Inserted 0 rows`);
    // else console.log(`\t-> ⚠️ Only inserted ${ret.length} of ${data.length} rows`);
    console.log(`\t-> ✔️ Inserted ${data.length} rows`);

    return ret;
  } catch (error) {
    const e = error as DatabaseError;
    console.log(`\t-> ❌  ${e.message}`);
    if (e.detail) console.log(`\t-> Detail: ${e.detail}`);
    if (e.where) console.log(`\t-> where: ${e.where}`);
    return [];
  }
};

const truncateRows = async () => {
  console.log('Truncating tables');
  await pgDbWrite.query(
    `TRUNCATE TABLE
      "User", "Tag", "Leaderboard", "AuctionBase", "Tool", "Technique", "TagsOnImageNew", "EntityMetric", "JobQueue", "KeyValue",
      "ImageRank", "ModelVersionRank", "UserRank", "TagRank", "ArticleRank", "CollectionRank",
      "Changelog", "Report"
      RESTART IDENTITY CASCADE;`
  );
};

const truncateNotificationRows = async () => {
  console.log('Truncating notification tables');
  await notifDbWrite.query('TRUNCATE TABLE "Notification" RESTART IDENTITY CASCADE');
};

/**
 * User
 */
const genUsers = (num: number, includeCiv = false) => {
  const ret = [];

  const extraUsers = [];

  if (includeCiv) {
    // civ user
    extraUsers.push([
      'Civitai',
      'hello@civitai.com',
      null,
      null,
      -1,
      true,
      false,
      'civitai',
      true,
      '2021-11-13 00:00:00.000',
      null,
      null,
      null,
      null,
      true,
      '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}',
      null,
      null,
      '{"scores": {"total": 39079263, "users": 223000, "images": 2043471, "models": 36812792, "reportsAgainst": -8000, "reportsActioned": null}, "firstImage": "2022-11-09T17:39:48.137"}',
      '{"newsletterSubscriber": true}',
      null,
      false,
      1,
      0,
      '{}',
      null,
      false,
      null,
      'Eligible',
      null,
    ]);

    // - test users

    // mod
    extraUsers.push([
      'Test - Moderator', // name
      'test-mod@civitai.com', // email
      null,
      null,
      1, // id
      false, // blurnsfw
      true, // shownsfw
      'test_mod', // username
      true, // isMod
      '2021-11-13 00:00:00.000',
      null, // deletedAt
      null, // bannedAt
      null,
      null,
      true,
      '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}',
      null,
      null,
      '{}', // meta
      '{}', // settings
      null, // "mutedAt"
      false, // muted
      31, // "browsingLevel"
      15, // onboarding
      '{}', // "publicSettings"
      null, // "muteConfirmedAt"
      false,
      null,
      'Eligible',
      `ctm_01j6${faker.string.alphanumeric(22)}`,
    ]);

    // newbie
    extraUsers.push([
      'Test - Newbie', // name
      'test-newbie@civitai.com', // email
      null,
      null,
      2, // id
      true, // blurnsfw
      false, // shownsfw
      'test_newbie', // username
      false, // isMod
      '2024-11-13 00:00:00.000',
      null, // deletedAt
      null, // bannedAt
      null,
      null,
      false,
      '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}',
      null,
      null,
      '{}', // meta
      '{}', // settings
      null, // "mutedAt"
      false, // muted
      1, // "browsingLevel"
      0, // onboarding
      '{}', // "publicSettings"
      null, // "muteConfirmedAt"
      false,
      null,
      'Eligible',
      null,
    ]);

    // degen
    extraUsers.push([
      'Test - Degen', // name
      'test-degen@civitai.com', // email
      '2023-11-14 00:00:00.000',
      null,
      3, // id
      false, // blurnsfw
      true, // shownsfw
      'test_degen', // username
      false, // isMod
      '2023-11-13 00:00:00.000',
      null, // deletedAt
      null, // bannedAt
      null,
      null,
      true,
      '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}',
      null,
      null,
      '{"scores": {"total": 374, "users": 300, "images": 70, "models": 4, "reportsActioned": 50}}', // meta
      '{}', // settings
      null, // "mutedAt"
      false, // muted
      31, // "browsingLevel"
      15, // onboarding
      '{}', // "publicSettings"
      null, // "muteConfirmedAt"
      false,
      null,
      'Eligible',
      `ctm_01j6${faker.string.alphanumeric(22)}`,
    ]);

    // banned
    extraUsers.push([
      'Test - Banned', // name
      'test-banned@civitai.com', // email
      '2023-11-14 00:00:00.000',
      null,
      4, // id
      false, // blurnsfw
      true, // shownsfw
      'test_banned', // username
      false, // isMod
      '2023-11-13 00:00:00.000',
      null, // deletedAt
      '2023-11-17 00:00:00.000', // bannedAt
      null,
      null,
      true,
      '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}',
      null,
      null,
      '{}', // meta
      '{}', // settings
      null, // "mutedAt"
      false, // muted
      31, // "browsingLevel"
      15, // onboarding
      '{}', // "publicSettings"
      null, // "muteConfirmedAt"
      false,
      null,
      'Eligible',
      `ctm_01j6${faker.string.alphanumeric(22)}`,
    ]);

    // deleted
    extraUsers.push([
      'Test - Deleted', // name
      'test-deleted@civitai.com', // email
      '2023-11-14 00:00:00.000',
      null,
      5, // id
      false, // blurnsfw
      true, // shownsfw
      'test_deleted', // username
      false, // isMod
      '2023-11-13 00:00:00.000',
      '2023-11-17 00:00:00.000', // deletedAt
      null, // bannedAt
      null,
      null,
      true,
      '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}',
      null,
      null,
      '{}', // meta
      '{}', // settings
      null, // "mutedAt"
      false, // muted
      31, // "browsingLevel"
      15, // onboarding
      '{}', // "publicSettings"
      null, // "muteConfirmedAt"
      false,
      null,
      'Eligible',
      `ctm_01j6${faker.string.alphanumeric(22)}`,
    ]);

    // muted
    extraUsers.push([
      'Test - Muted', // name
      'test-muted@civitai.com', // email
      '2023-11-14 00:00:00.000',
      null,
      6, // id
      false, // blurnsfw
      true, // shownsfw
      'test_muted', // username
      false, // isMod
      '2023-11-13 00:00:00.000',
      null, // deletedAt
      null, // bannedAt
      null,
      null,
      true,
      '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}',
      null,
      null,
      '{}', // meta
      '{}', // settings
      '2023-11-17 00:00:00.000', // "mutedAt"
      true, // muted
      31, // "browsingLevel"
      15, // onboarding
      '{}', // "publicSettings"
      '2023-11-17 01:00:00.000', // "muteConfirmedAt"
      false,
      null,
      'Eligible',
      `ctm_01j6${faker.string.alphanumeric(22)}`,
    ]);

    // subscriber
    // customerSubscription?

    ret.push(...extraUsers);
    num += extraUsers.length;
  }

  const seenUserNames: string[] = [];

  // random users
  for (let step = extraUsers.length + (includeCiv ? 0 : 1); step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const isMuted = fbool(0.01);
    let username = randPrependBad(faker.internet.username(), '.');
    if (seenUserNames.includes(username)) username = `${username}_${faker.number.int(1_000)}`;
    seenUserNames.push(username);

    const row = [
      randw([
        { value: null, weight: 1 },
        { value: faker.person.fullName(), weight: 20 },
      ]), // name
      randw([
        { value: null, weight: 1 },
        { value: faker.internet.email(), weight: 20 },
      ]), // email
      randw([
        { value: null, weight: 1 },
        { value: faker.date.between({ from: created, to: Date.now() }).toISOString(), weight: 3 },
      ]), // "emailVerified"
      randw([
        { value: null, weight: 1 },
        { value: faker.image.avatar(), weight: 10 },
      ]), // image
      step, // id
      fbool(), // "blurNsfw"
      fbool(), // "showNsfw"
      randw([
        { value: null, weight: 1 },
        { value: username, weight: 20 },
      ]), // username
      fbool(0.01), // "isModerator"
      created, // "createdAt"
      randw([
        { value: null, weight: 100 },
        { value: faker.date.between({ from: created, to: Date.now() }).toISOString(), weight: 1 },
      ]), // "deletedAt"
      randw([
        { value: null, weight: 100 },
        { value: faker.date.between({ from: created, to: Date.now() }).toISOString(), weight: 1 },
      ]), // "bannedAt"
      randw([
        { value: null, weight: 1 },
        { value: `cus_Na${faker.string.alphanumeric(12)}`, weight: 5 },
      ]), // "customerId"
      randw([
        { value: null, weight: 10 },
        { value: `sub_${faker.string.alphanumeric(24)}`, weight: 1 },
      ]), // "subscriptionId"
      fbool(), // "autoplayGifs"
      '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}', // "filePreferences" // TODO make random
      randw([
        { value: null, weight: 30 },
        { value: 'overall', weight: 2 },
        { value: 'new_creators', weight: 1 },
      ]), // "leaderboardShowcase"
      null, // "profilePictureId" // TODO link with Image ID
      randw([
        { value: '{}', weight: 5 },
        { value: '{"scores": {"total": 0, "users": 0}}', weight: 3 },
        {
          value: `{"scores": {"total": ${faker.number.int(10_000_000)}, "users": ${faker.number.int(
            100_000
          )}, "images": ${faker.number.int(100_000)}, "models": ${faker.number.int(
            1_000_000
          )}, "articles": ${faker.number.int(100_000)}}, "firstImage": "${faker.date
            .between({ from: created, to: Date.now() })
            .toISOString()}"}`,
          weight: 1,
        },
      ]), // meta
      '{}', // settings // TODO not sure if we even need this
      isMuted ? faker.date.between({ from: created, to: Date.now() }).toISOString() : null, // "mutedAt"
      isMuted, // muted
      rand([1, 31]), // "browsingLevel" // TODO which other ones?
      rand([3, 15]), // onboarding // TODO which other ones?
      '{}', // "publicSettings" // TODO not sure if we even need this
      isMuted ? faker.date.between({ from: created, to: Date.now() }).toISOString() : null, // "muteConfirmedAt"
      fbool(0.01), // "excludeFromLeaderboards"
      null, // "eligibilityChangedAt" // TODO
      'Eligible', // "rewardsEligibility" // TODO
      randw([
        { value: null, weight: 3 },
        { value: `ctm_01j6${faker.string.alphanumeric(22)}`, weight: 1 },
      ]), // "paddleCustomerId"
    ];

    ret.push(row);
  }

  return ret;
};

/**
 * UserProfile
 */
const genUserProfiles = (userIds: number[], imageIds: number[]) => {
  // const selectedUserIds = faker.helpers.arrayElements(userIds, num);
  const ret = [];

  for (const userId of userIds) {
    const message = randw([
      { value: null, weight: 10 },
      { value: randPrependBad(faker.lorem.sentence()), weight: 1 },
    ]);

    const row = [
      userId, // "userId"
      randw([
        { value: null, weight: 10 },
        { value: rand(imageIds), weight: 1 },
      ]), // coverImageId
      randw([
        { value: null, weight: 10 },
        { value: randPrependBad(faker.lorem.sentences({ min: 1, max: 3 })), weight: 1 },
      ]), // bio
      message, // message
      !!message ? faker.date.past({ years: 3 }).toISOString() : null, // messageAddedAt
      '{}', // privacySettings
      '[{"key": "showcase", "enabled": true}, {"key": "popularModels", "enabled": true}, {"key": "popularArticles", "enabled": true}, {"key": "modelsOverview", "enabled": true}, {"key": "imagesOverview", "enabled": true}, {"key": "recentReviews", "enabled": true}]', // profileSectionsSettings
      randw([
        { value: null, weight: 10 },
        { value: `${faker.location.city()}, ${faker.location.country()}`, weight: 1 },
      ]), // location
      fbool(0.01), // nsfw
      randw([
        { value: '[]', weight: 10 },
        { value: `[{"entityId": ${rand(imageIds)}, "entityType": "Image"}]`, weight: 1 }, // TODO need to get users images
      ]), // showcaseItems
    ];

    ret.push(row);
  }

  return ret;
};

/**
 * Model
 */
const genModels = (num: number, userIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const isCheckpoint = fbool(0.3);
    const isLora = fbool(0.6);
    const isDeleted = fbool(0.05);
    const isPublished = fbool(0.4);
    const isEa = fbool(0.05);

    const row = [
      randPrependBad(generateRandomName(faker.number.int({ min: 1, max: 6 }))), // name
      rand([null, `<p>${randPrependBad(faker.lorem.paragraph({ min: 1, max: 8 }))}</p>`]), // description
      isCheckpoint
        ? 'Checkpoint'
        : isLora
        ? 'LORA'
        : rand(Object.values(ModelType).filter((v) => !['Checkpoint', 'LORA'].includes(v))), // type
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      fbool(), // nsfw
      step, // id
      rand(userIds), // userId
      fbool(0.01), // tosViolation
      isDeleted
        ? 'Deleted'
        : isPublished
        ? 'Published'
        : rand(Object.values(ModelStatus).filter((v) => !['Deleted', 'Published'].includes(v))), // status
      null, // fromImportId // TODO
      fbool(0.1), // poi
      isPublished ? faker.date.between({ from: created, to: Date.now() }).toISOString() : null, // publishedAt
      faker.date.between({ from: created, to: Date.now() }).toISOString(), // lastVersionAt // TODO this one is annoying
      '{}', // meta
      fbool(), // allowDerivatives
      fbool(), // allowDifferentLicense
      fbool(), // allowNoCredit
      isDeleted ? faker.date.between({ from: created, to: Date.now() }).toISOString() : null, // deletedAt
      isCheckpoint ? rand(Object.values(CheckpointType)) : null, // checkpointType
      fbool(0.01), // locked
      isDeleted ? rand(userIds) : null, // deletedBy
      fbool(0.001), // underAttack
      isEa ? faker.date.future().toISOString() : null, // earlyAccessDeadline
      randw([
        { value: null, weight: 100 },
        { value: rand(Object.values(ModelModifier)), weight: 1 },
      ]), // mode
      isLora ? rand(Object.values(ModelUploadType)) : 'Created', // uploadType
      fbool(0.05), // unlisted
      randw([
        { value: '{}', weight: 20 },
        { value: '{"level": 31}', weight: 1 },
      ]), // gallerySettings
      isEa
        ? 'EarlyAccess'
        : randw([
            { value: 'Public', weight: 30 },
            {
              value: rand(
                Object.values(Availability).filter((v) => !['Public', 'EarlyAccess'].includes(v))
              ),
              weight: 1,
            },
          ]), // availability
      rand(['{Sell}', '{Image,RentCivit,Rent,Sell}', '{Image,RentCivit}']), // allowCommercialUse
      randw([
        { value: 0, weight: 5 },
        { value: 1, weight: 4 },
        { value: 28, weight: 3 },
        { value: 15, weight: 2 },
        { value: 31, weight: 2 },
      ]), // nsfwLevel
      '{}', // lockedProperties
      fbool(0.05), // minor
    ];
    ret.push(row);
  }
  return ret;
};

/**
 * ModelVersion
 */
const genMvs = (num: number, modelData: { id: number; uploadType: ModelUploadType }[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const model = rand(modelData);
    const isTrain = model.uploadType === 'Trained';
    const created = faker.date.past({ years: 3 }).toISOString();
    const isDeleted = fbool(0.05);
    const isPublished = fbool(0.4);

    const row = [
      randw([
        { value: `V${faker.number.int(6)}`, weight: 5 },
        { value: generateRandomName(faker.number.int({ min: 1, max: 6 })), weight: 1 },
      ]), // name
      rand([null, `<p>${faker.lorem.sentence()}</p>`]), // description
      isTrain ? faker.number.int({ min: 10, max: 10_000 }) : null, // steps
      isTrain ? faker.number.int({ min: 1, max: 200 }) : null, // epochs
      created, // createdAt // nb: not perfect since it can be different from the model
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      step, // id
      model.id, // modelId
      rand(['{}', `{${faker.word.noun()}}`]), // trainedWords
      isDeleted
        ? 'Deleted'
        : isPublished
        ? 'Published'
        : rand(Object.values(ModelStatus).filter((v) => !['Deleted', 'Published'].includes(v))), // status
      null, // fromImportId // TODO
      faker.number.int({ min: 1, max: 8 }), // index // TODO needs other indices?
      fbool(0.01), // inaccurate
      rand(baseModels), // baseModel
      rand(['{}', '{"imageNsfwLevel": 1}', '{"imageNsfwLevel": 8}']), // meta
      0, // earlyAccessTimeframe // TODO check model early access
      isPublished ? faker.date.between({ from: created, to: Date.now() }).toISOString() : null, // publishedAt
      rand([null, 1, 2]), // clipSkip
      null, // vaeId // TODO
      randw([
        { value: 'Standard', weight: 30 },
        { value: rand(constants.baseModelTypes.filter((v) => v !== 'Standard')), weight: 2 },
      ]), // baseModelType
      isTrain
        ? rand([
            '{}',
            '{"type": "Character"}',
            '{"type": "Character", "mediaType": "video"}',
            '{"type": "Character", "params": {"engine": "kohya", "unetLR": 0.0005, "clipSkip": 1, "loraType": "lora", "keepTokens": 0, "networkDim": 32, "numRepeats": 14, "resolution": 512, "lrScheduler": "cosine_with_restarts", "minSnrGamma": 5, "noiseOffset": 0.1, "targetSteps": 1050, "enableBucket": true, "networkAlpha": 16, "optimizerType": "AdamW8Bit", "textEncoderLR": 0.00005, "maxTrainEpochs": 10, "shuffleCaption": false, "trainBatchSize": 2, "flipAugmentation": false, "lrSchedulerNumCycles": 3}, "staging": false, "baseModel": "realistic", "highPriority": false, "baseModelType": "sd15", "samplePrompts": ["", "", ""]}',
          ])
        : null, // trainingDetails
      isTrain ? rand(Object.values(TrainingStatus)) : null, // trainingStatus
      fbool(0.2), // requireAuth
      rand([null, '{"strength": 1, "maxStrength": 2, "minStrength": 0.1}']), // settings
      randw([
        { value: 'Public', weight: 2 },
        { value: 'Private', weight: 1 },
      ]), // availability
      randw([
        { value: 0, weight: 5 },
        { value: 1, weight: 4 },
        { value: 28, weight: 3 },
        { value: 15, weight: 2 },
        { value: 31, weight: 2 },
      ]), // nsfwLevel
      null, // earlyAccessConfig // TODO
      null, // earlyAccessEndsAt // TODO
      model.uploadType, // uploadType
    ];
    ret.push(row);
  }
  return ret;
};

// TODO do these URLs work?
const _modelFileTypeMap = {
  Model: {
    ext: 'safetensors',
    url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/modelVersion/627691/Capitan_V2_Nyakumi_Neko_style.safetensors',
    meta: '{"fp": "fp16", "size": "full", "format": "SafeTensor"}',
    metaTrain:
      '{"format": "SafeTensor", "selectedEpochUrl": "https://orchestration.civitai.com/v1/consumer/jobs/2604a7f9-fced-4279-bc4e-05fc3bd95e29/assets/Capitan_V2_Nyakumi_Neko_style.safetensors"}',
  },
  'Training Data': {
    ext: 'zip',
    url: 'https://civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/training-images/3625125/806329TrainingData.yqVq.zip',
    meta: '{"fp": null, "size": null, "format": "Other"}',
    metaTrain:
      '{"format": "Other", "numImages": 26, "ownRights": false, "numCaptions": 26, "shareDataset": false, "trainingResults": {"jobId": "c5657331-beee-488d-97fa-8b9e6d6fd48f", "epochs": [{"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo-000001.safetensors", "epoch_number": 1, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000001_00_20240904200838.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000001_01_20240904200845.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000001_02_20240904200852.png"}]}, {"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo-000002.safetensors", "epoch_number": 2, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000002_00_20240904201044.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000002_01_20240904201051.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000002_02_20240904201058.png"}]}, {"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo-000003.safetensors", "epoch_number": 3, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000003_00_20240904201248.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000003_01_20240904201255.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000003_02_20240904201302.png"}]}, {"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo-000004.safetensors", "epoch_number": 4, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000004_00_20240904201452.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000004_01_20240904201459.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000004_02_20240904201505.png"}]}, {"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo-000005.safetensors", "epoch_number": 5, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000005_00_20240904201656.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000005_01_20240904201702.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000005_02_20240904201709.png"}]}, {"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo-000006.safetensors", "epoch_number": 6, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000006_00_20240904201900.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000006_01_20240904201907.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000006_02_20240904201913.png"}]}, {"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo-000007.safetensors", "epoch_number": 7, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000007_00_20240904202103.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000007_01_20240904202110.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000007_02_20240904202117.png"}]}, {"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo-000008.safetensors", "epoch_number": 8, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000008_00_20240904202306.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000008_01_20240904202313.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000008_02_20240904202320.png"}]}, {"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo-000009.safetensors", "epoch_number": 9, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000009_00_20240904202510.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000009_01_20240904202517.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000009_02_20240904202523.png"}]}, {"model_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo.safetensors", "epoch_number": 10, "sample_images": [{"prompt": "blademancy, furry", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000010_00_20240904202715.png"}, {"prompt": "light particles, dual wielding, brown hair, standing, holding, grey background, beard, gradient, no humans, necktie", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000010_01_20240904202721.png"}, {"prompt": "dagger, scar, weapon, english text, halberd, blue necktie, facial hair, artist name, green theme, formal", "image_url": "https://orchestration.civitai.com/v1/consumer/jobs/c5657331-beee-488d-97fa-8b9e6d6fd48f/assets/blademancer_2_stabby_boogaloo_e000010_02_20240904202728.png"}]}], "history": [{"time": "2024-09-04T19:58:04.411Z", "jobId": "c5657331-beee-488d-97fa-8b9e6d6fd48f", "status": "Submitted"}, {"time": "2024-09-04T19:58:10.988Z", "status": "Processing", "message": ""}, {"time": "2024-09-04T20:29:37.747Z", "status": "InReview", "message": "Job complete"}], "attempts": 1, "end_time": "2024-09-04T20:29:35.087Z", "start_time": "2024-09-04T19:58:09.668Z", "submittedAt": "2024-09-04T19:58:04.411Z", "transactionId": "2ebb5147-5fd3-4dbb-a735-e206d218686b"}}',
  },
  Archive: {
    ext: 'zip',
    url: 'https://civitai-delivery-worker-prod-2023-05-01.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/91602/default/bingLogoRemoval.2ayv.zip',
    meta: '{"fp": null, "size": null, "format": "Other"}',
    metaTrain: '{"fp": null, "size": null, "format": "Other"}',
  },
  Config: {
    ext: 'yaml',
    url: 'https://civitai-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/14014/training-images/somnia140.cR9o.yaml',
    meta: '{"format": "Other"}',
    metaTrain: '{"format": "Other"}',
  },
  Negative: {
    ext: 'pt',
    url: 'https://civitai-delivery-worker-prod-2023-10-01.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/default/3336/aloeanticgi1500.sPBn.pt',
    meta: '{"fp": null, "size": null, "format": "Other"}',
    metaTrain: '{"fp": null, "size": null, "format": "Other"}',
  },
  'Pruned Model': {
    ext: 'safetensors',
    url: 'https://civitai-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com/78515/training-images/mihaV3E100.cCux.safetensors',
    meta: '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}',
    metaTrain: '{"fp": "fp16", "size": "pruned", "format": "SafeTensor"}',
  },
};

const _genMFileData = (
  num: number,
  step: number,
  mv: { id: number; uploadType: ModelUploadType }
) => {
  const isTrain = mv.uploadType === 'Trained';
  const created = faker.date.past({ years: 3 }).toISOString();
  const passScan = fbool(0.98);

  const availTypes = [
    { value: 'Model', weight: 20 },
    { value: 'Training Data', weight: 5 },
    { value: 'Archive', weight: 1 },
    { value: 'Config', weight: 1 },
    { value: 'Negative', weight: 1 },
    { value: 'Pruned Model', weight: 1 },
  ] as const;
  const seenTypes: string[] = [];

  const rows = [];
  let currentId = step;

  for (let i = 0; i < num; i++) {
    currentId++;
    const remainingTypes = availTypes.filter((type) => !seenTypes.includes(type.value));
    const type = randw(remainingTypes);
    seenTypes.push(type);

    const row = [
      (type === 'Training Data'
        ? `${mv.id}_training_data`
        : `${faker.word.noun()}_${faker.number.int(100)}`) + `.${_modelFileTypeMap[type].ext}`, // name
      _modelFileTypeMap[type].url, // url
      faker.number.float(2_000_000), // sizeKB
      created, // createdAt
      mv.id, // modelVersionId
      passScan
        ? ScanResultCode.Success
        : rand(Object.values(ScanResultCode).filter((v) => !['Success'].includes(v))), // pickleScanResult
      'No Pickle imports', // pickleScanMessage
      passScan
        ? ScanResultCode.Success
        : rand(Object.values(ScanResultCode).filter((v) => !['Success'].includes(v))), // virusScanResult
      null, // virusScanMessage
      passScan ? faker.date.between({ from: created, to: Date.now() }).toISOString() : null, // scannedAt
      passScan
        ? `{"url": "${
            _modelFileTypeMap[type].url
          }", "fixed": null, "hashes": {"CRC32": "${faker.string.hexadecimal({
            length: 8,
            casing: 'upper',
            prefix: '',
          })}", "AutoV1": "${faker.string.hexadecimal({
            length: 8,
            casing: 'upper',
            prefix: '',
          })}", "AutoV2": "${faker.string.hexadecimal({
            length: 10,
            casing: 'upper',
            prefix: '',
          })}", "AutoV3": "${faker.string.hexadecimal({
            length: 64,
            casing: 'upper',
            prefix: '',
          })}", "Blake3": "${faker.string.hexadecimal({
            length: 64,
            casing: 'upper',
            prefix: '',
          })}", "SHA256": "${faker.string.hexadecimal({
            length: 64,
            casing: 'upper',
            prefix: '',
          })}"}, "fileExists": 1, "conversions": {}, "clamscanOutput": "", "clamscanExitCode": 0, "picklescanOutput": "", "picklescanExitCode": 0, "picklescanGlobalImports": null, "picklescanDangerousImports": null}`
        : null, // rawScanResult
      faker.date.between({ from: created, to: Date.now() }).toISOString(), // scanRequestedAt
      randw([
        { value: null, weight: 2 },
        { value: true, weight: 3 },
        { value: false, weight: 1 },
      ]), // exists
      currentId, // id
      type, // type
      isTrain ? _modelFileTypeMap[type].metaTrain : _modelFileTypeMap[type].meta, // metadata
      rand(Object.values(ModelFileVisibility)), // visibility
      fbool(0.1), // dataPurged
      type === 'Model'
        ? '{"ss_v2": "False", "ss_seed": "431671283", "ss_epoch": "6", "ss_steps": "444", "ss_lowram": "False", "ss_unet_lr": "1.0", "ss_datasets": "[{\\"is_dreambooth\\": true, \\"batch_size_per_device\\": 5, \\"num_train_images\\": 204, \\"num_reg_images\\": 0, \\"resolution\\": [1024, 1024], \\"enable_bucket\\": true, \\"min_bucket_reso\\": 256, \\"max_bucket_reso\\": 2048, \\"tag_frequency\\": {\\"img\\": {\\"1girl\\": 96, \\"solo\\": 63, \\"hat\\": 63, \\"skirt\\": 28, \\"armband\\": 11, \\"vest\\": 37, \\"open mouth\\": 46, \\"brown hair\\": 75, \\"brown vest\\": 2, \\"cowboy hat\\": 8, \\"shirt\\": 17, \\"white shirt\\": 11, \\"closed eyes\\": 10, \\"smile\\": 40, \\"water\\": 3, \\"wet\\": 2, \\"nude\\": 1, \\"long hair\\": 40, \\"outdoors\\": 7, \\"bathing\\": 1, \\"tattoo\\": 2, \\"witch hat\\": 19, \\"food\\": 2, \\"sitting\\": 13, \\"indian style\\": 1, \\"cup\\": 6, \\"bare shoulders\\": 2, \\"steam\\": 2, \\"brown eyes\\": 16, \\"off shoulder\\": 2, \\"holding\\": 11, \\"blue eyes\\": 8, \\"cat\\": 25, \\"blue sky\\": 1, \\"day\\": 9, \\"sky\\": 7, \\"surprised\\": 5, \\"black hair\\": 22, \\"white background\\": 4, \\"wide-eyed\\": 5, \\"dress\\": 7, \\"off-shoulder dress\\": 1, \\"simple background\\": 5, \\"looking at viewer\\": 9, \\"blush\\": 19, \\"door\\": 1, \\"long sleeves\\": 8, \\"book\\": 16, \\"socks\\": 12, \\"bookshelf\\": 2, \\"barefoot\\": 2, \\"heart\\": 2, \\"white dress\\": 2, \\"breasts\\": 1, \\"sleeveless\\": 1, \\"upper body\\": 8, \\"frown\\": 1, \\"closed mouth\\": 7, \\"grin\\": 2, \\"short hair\\": 3, \\"running\\": 4, \\"motion blur\\": 1, \\"bag\\": 14, \\"speed lines\\": 1, \\"arm up\\": 1, \\"laughing\\": 1, \\":d\\": 3, \\"freckles\\": 4, \\"clenched teeth\\": 1, \\"teeth\\": 2, \\"leg warmers\\": 4, \\"loose socks\\": 3, \\"^^^\\": 2, \\"one eye closed\\": 2, \\"black eyes\\": 2, \\"broom\\": 9, \\"railing\\": 1, \\"boots\\": 9, \\"paper\\": 2, \\"holding paper\\": 1, \\"brown headwear\\": 1, \\"plaid\\": 2, \\"indoors\\": 2, \\"hands on hips\\": 2, \\"spiked hair\\": 3, \\"angry\\": 1, \\"from behind\\": 2, \\"dirty\\": 1, \\"red vest\\": 1, \\"belt\\": 2, \\"1boy\\": 3, \\"solo focus\\": 1, \\"shorts\\": 3, \\"striped\\": 1, \\"torn clothes\\": 2, \\"male focus\\": 2, \\"signature\\": 1, \\"from side\\": 2, \\"handbag\\": 4, \\"reading\\": 2, \\"walking\\": 1, \\"quill\\": 2, \\"feathers\\": 2, \\"fingernails\\": 1, \\"holding book\\": 3, \\"open book\\": 2, \\"robot\\": 1, \\"spider web\\": 1, \\"silk\\": 1, \\"messenger bag\\": 1, \\"weapon\\": 3, \\"sword\\": 2, \\"grass\\": 3, \\"nature\\": 5, \\"tree\\": 6, \\"forest\\": 4, \\"apron\\": 2, \\"sleeves rolled up\\": 1, \\"tray\\": 1, \\"tears\\": 3, \\"horse\\": 1, \\"covering face\\": 1, \\"kneehighs\\": 1, \\"bottle\\": 2, \\"blue background\\": 2, \\"sweat\\": 1, \\"flask\\": 1, \\":o\\": 1, \\"orange background\\": 1, \\"mug\\": 2, \\"messy hair\\": 1, \\"stick\\": 1, \\"injury\\": 1, \\"sleeping\\": 1, \\"lying\\": 2, \\"broom riding\\": 5, \\"cape\\": 2, \\"coin\\": 1, \\"crying\\": 2, \\"kneeling\\": 1, \\"holding weapon\\": 1, \\"holding sword\\": 1, \\"multiple girls\\": 3, \\"2girls\\": 1, \\"braid\\": 2, \\"fire\\": 4, \\"portrait\\": 2, \\"sidelocks\\": 1, \\"forehead\\": 2, \\"v-shaped eyebrows\\": 1, \\"looking to the side\\": 1, \\"basket\\": 2, \\"cave\\": 1, \\"straw hat\\": 3, \\"flower\\": 1, \\"from above\\": 1, \\"looking up\\": 1, \\"multiple boys\\": 1, \\"armor\\": 1, \\"polearm\\": 1, \\"ocean\\": 1, \\"cloud\\": 5, \\"beach\\": 2, \\"blurry\\": 1, \\"blurry background\\": 1, \\"skewer\\": 1, \\"multicolored hair\\": 1, \\"two-tone hair\\": 1, \\"swimsuit\\": 4, \\"fish\\": 1, \\"fork\\": 1, \\"bikini\\": 3, \\"navel\\": 1, \\"polka dot\\": 3, \\"polka dot bikini\\": 2, \\"monochrome\\": 5, \\"greyscale\\": 5, \\"bow\\": 2, \\"watercraft\\": 1, \\"boat\\": 1, \\"witch\\": 2, \\"shell\\": 1, \\"jewelry\\": 1, \\"earrings\\": 1, \\"head rest\\": 2, \\"rabbit\\": 1, \\"chair\\": 2, \\"suspenders\\": 1, \\"window\\": 1, \\"plant\\": 1, \\"holding cup\\": 1, \\"pants\\": 1, \\"tentacles\\": 1, \\"underwater\\": 1, \\"octopus\\": 1, \\"bubble\\": 1, \\"air bubble\\": 1, \\"playing games\\": 1, \\"board game\\": 1, \\"hood\\": 1, \\"staff\\": 1, \\"hood up\\": 1, \\"hug\\": 1, \\"purple hair\\": 1, \\"hand to own mouth\\": 1, \\"green shirt\\": 1, \\"gloves\\": 3, \\"flying\\": 4, \\"bird\\": 1, \\"mouse\\": 2, \\"animal\\": 1, \\"rain\\": 1, \\"under tree\\": 1, \\"against tree\\": 1, \\"expressions\\": 1, \\"multiple views\\": 1, \\"reference sheet\\": 1, \\"airship\\": 1, \\"falling\\": 1, \\"floating island\\": 1, \\"crossed arms\\": 1, \\"brown background\\": 1, \\"profile\\": 1, \\"potion\\": 1, \\"sketch\\": 2, \\"thinking\\": 1, \\"hand on own chin\\": 1, \\"detached sleeves\\": 1}}, \\"bucket_info\\": {\\"buckets\\": {\\"0\\": {\\"resolution\\": [128, 256], \\"count\\": 2}, \\"1\\": {\\"resolution\\": [128, 320], \\"count\\": 2}, \\"2\\": {\\"resolution\\": [128, 448], \\"count\\": 2}, \\"3\\": {\\"resolution\\": [192, 256], \\"count\\": 10}, \\"4\\": {\\"resolution\\": [192, 384], \\"count\\": 2}, \\"5\\": {\\"resolution\\": [192, 448], \\"count\\": 2}, \\"6\\": {\\"resolution\\": [192, 512], \\"count\\": 4}, \\"7\\": {\\"resolution\\": [192, 768], \\"count\\": 2}, \\"8\\": {\\"resolution\\": [256, 128], \\"count\\": 2}, \\"9\\": {\\"resolution\\": [256, 192], \\"count\\": 6}, \\"10\\": {\\"resolution\\": [256, 256], \\"count\\": 4}, \\"11\\": {\\"resolution\\": [256, 384], \\"count\\": 2}, \\"12\\": {\\"resolution\\": [256, 448], \\"count\\": 8}, \\"13\\": {\\"resolution\\": [256, 512], \\"count\\": 2}, \\"14\\": {\\"resolution\\": [256, 768], \\"count\\": 2}, \\"15\\": {\\"resolution\\": [320, 256], \\"count\\": 2}, \\"16\\": {\\"resolution\\": [320, 576], \\"count\\": 2}, \\"17\\": {\\"resolution\\": [320, 704], \\"count\\": 4}, \\"18\\": {\\"resolution\\": [320, 768], \\"count\\": 4}, \\"19\\": {\\"resolution\\": [320, 896], \\"count\\": 2}, \\"20\\": {\\"resolution\\": [384, 192], \\"count\\": 2}, \\"21\\": {\\"resolution\\": [384, 256], \\"count\\": 2}, \\"22\\": {\\"resolution\\": [384, 448], \\"count\\": 2}, \\"23\\": {\\"resolution\\": [384, 512], \\"count\\": 2}, \\"24\\": {\\"resolution\\": [384, 576], \\"count\\": 4}, \\"25\\": {\\"resolution\\": [384, 640], \\"count\\": 4}, \\"26\\": {\\"resolution\\": [384, 704], \\"count\\": 2}, \\"27\\": {\\"resolution\\": [384, 832], \\"count\\": 2}, \\"28\\": {\\"resolution\\": [448, 128], \\"count\\": 2}, \\"29\\": {\\"resolution\\": [448, 448], \\"count\\": 4}, \\"30\\": {\\"resolution\\": [448, 576], \\"count\\": 4}, \\"31\\": {\\"resolution\\": [448, 640], \\"count\\": 4}, \\"32\\": {\\"resolution\\": [448, 704], \\"count\\": 2}, \\"33\\": {\\"resolution\\": [448, 768], \\"count\\": 2}, \\"34\\": {\\"resolution\\": [512, 512], \\"count\\": 2}, \\"35\\": {\\"resolution\\": [512, 640], \\"count\\": 2}, \\"36\\": {\\"resolution\\": [512, 704], \\"count\\": 4}, \\"37\\": {\\"resolution\\": [512, 768], \\"count\\": 4}, \\"38\\": {\\"resolution\\": [512, 1024], \\"count\\": 2}, \\"39\\": {\\"resolution\\": [576, 704], \\"count\\": 2}, \\"40\\": {\\"resolution\\": [576, 768], \\"count\\": 4}, \\"41\\": {\\"resolution\\": [576, 1024], \\"count\\": 2}, \\"42\\": {\\"resolution\\": [704, 448], \\"count\\": 2}, \\"43\\": {\\"resolution\\": [704, 768], \\"count\\": 4}, \\"44\\": {\\"resolution\\": [704, 832], \\"count\\": 2}, \\"45\\": {\\"resolution\\": [704, 1024], \\"count\\": 2}, \\"46\\": {\\"resolution\\": [768, 576], \\"count\\": 2}, \\"47\\": {\\"resolution\\": [768, 768], \\"count\\": 2}, \\"48\\": {\\"resolution\\": [832, 576], \\"count\\": 2}, \\"49\\": {\\"resolution\\": [832, 832], \\"count\\": 2}, \\"50\\": {\\"resolution\\": [832, 1024], \\"count\\": 4}, \\"51\\": {\\"resolution\\": [896, 576], \\"count\\": 2}, \\"52\\": {\\"resolution\\": [896, 768], \\"count\\": 2}, \\"53\\": {\\"resolution\\": [960, 704], \\"count\\": 2}, \\"54\\": {\\"resolution\\": [960, 832], \\"count\\": 2}, \\"55\\": {\\"resolution\\": [960, 960], \\"count\\": 2}, \\"56\\": {\\"resolution\\": [1024, 704], \\"count\\": 2}, \\"57\\": {\\"resolution\\": [1024, 768], \\"count\\": 2}, \\"58\\": {\\"resolution\\": [1024, 1024], \\"count\\": 6}, \\"59\\": {\\"resolution\\": [1088, 704], \\"count\\": 4}, \\"60\\": {\\"resolution\\": [1088, 896], \\"count\\": 4}, \\"61\\": {\\"resolution\\": [1152, 768], \\"count\\": 4}, \\"62\\": {\\"resolution\\": [1216, 768], \\"count\\": 6}, \\"63\\": {\\"resolution\\": [1216, 832], \\"count\\": 2}, \\"64\\": {\\"resolution\\": [1280, 768], \\"count\\": 2}, \\"65\\": {\\"resolution\\": [1344, 768], \\"count\\": 10}, \\"66\\": {\\"resolution\\": [1408, 640], \\"count\\": 2}, \\"67\\": {\\"resolution\\": [1472, 576], \\"count\\": 2}}, \\"mean_img_ar_error\\": 0.04257648019652614}, \\"subsets\\": [{\\"img_count\\": 102, \\"num_repeats\\": 2, \\"color_aug\\": false, \\"flip_aug\\": false, \\"random_crop\\": false, \\"shuffle_caption\\": true, \\"keep_tokens\\": 0, \\"image_dir\\": \\"img\\", \\"class_tokens\\": null, \\"is_reg\\": false}]}]", "ss_clip_skip": "2", "ss_full_fp16": "False", "ss_optimizer": "prodigyopt.prodigy.Prodigy(decouple=True,weight_decay=0.5,betas=(0.9, 0.99),use_bias_correction=False)", "ss_num_epochs": "10", "ss_session_id": "3851886725", "modelspec.date": "2024-09-11T15:17:43", "ss_network_dim": "32", "ss_output_name": "Pepper__Carrot", "modelspec.title": "Pepper__Carrot", "ss_dataset_dirs": "{\\"img\\": {\\"n_repeats\\": 2, \\"img_count\\": 102}}", "ss_lr_scheduler": "cosine", "ss_noise_offset": "0.03", "sshs_model_hash": "52e53d98fe907d8b11eba16ce27575bea66ea987e2a1c0a8e9c2240909f01ff3", "ss_cache_latents": "True", "ss_learning_rate": "1.0", "ss_max_grad_norm": "1.0", "ss_min_snr_gamma": "5.0", "ss_network_alpha": "32", "ss_sd_model_hash": "e577480d", "ss_sd_model_name": "290640.safetensors", "ss_tag_frequency": {"img": {":d": 3, ":o": 1, "^^^": 2, "bag": 14, "bow": 2, "cat": 25, "cup": 6, "day": 9, "hat": 63, "hug": 1, "mug": 2, "sky": 7, "wet": 2, "1boy": 3, "belt": 2, "bird": 1, "boat": 1, "book": 16, "cape": 2, "cave": 1, "coin": 1, "door": 1, "fire": 4, "fish": 1, "food": 2, "fork": 1, "grin": 2, "hood": 1, "nude": 1, "rain": 1, "silk": 1, "solo": 63, "tray": 1, "tree": 6, "vest": 37, "1girl": 96, "angry": 1, "apron": 2, "armor": 1, "beach": 2, "blush": 19, "boots": 9, "braid": 2, "broom": 9, "chair": 2, "cloud": 5, "dirty": 1, "dress": 7, "flask": 1, "frown": 1, "grass": 3, "heart": 2, "horse": 1, "lying": 2, "mouse": 2, "navel": 1, "ocean": 1, "pants": 1, "paper": 2, "plaid": 2, "plant": 1, "quill": 2, "robot": 1, "shell": 1, "shirt": 17, "skirt": 28, "smile": 40, "socks": 12, "staff": 1, "steam": 2, "stick": 1, "sweat": 1, "sword": 2, "tears": 3, "teeth": 2, "water": 3, "witch": 2, "2girls": 1, "animal": 1, "arm up": 1, "basket": 2, "bikini": 3, "blurry": 1, "bottle": 2, "bubble": 1, "crying": 2, "flower": 1, "flying": 4, "forest": 4, "gloves": 3, "injury": 1, "nature": 5, "potion": 1, "rabbit": 1, "shorts": 3, "sketch": 2, "skewer": 1, "tattoo": 2, "weapon": 3, "window": 1, "airship": 1, "armband": 11, "bathing": 1, "breasts": 1, "falling": 1, "handbag": 4, "holding": 11, "hood up": 1, "indoors": 2, "jewelry": 1, "octopus": 1, "polearm": 1, "profile": 1, "railing": 1, "reading": 2, "running": 4, "sitting": 13, "striped": 1, "walking": 1, "barefoot": 2, "blue sky": 1, "earrings": 1, "feathers": 2, "forehead": 2, "freckles": 4, "kneeling": 1, "laughing": 1, "outdoors": 7, "portrait": 2, "red vest": 1, "sleeping": 1, "swimsuit": 4, "thinking": 1, "blue eyes": 8, "bookshelf": 2, "from side": 2, "greyscale": 5, "head rest": 2, "kneehighs": 1, "long hair": 40, "open book": 2, "polka dot": 3, "sidelocks": 1, "signature": 1, "straw hat": 3, "surprised": 5, "tentacles": 1, "wide-eyed": 5, "witch hat": 19, "air bubble": 1, "black eyes": 2, "black hair": 22, "board game": 1, "brown eyes": 16, "brown hair": 75, "brown vest": 2, "cowboy hat": 8, "from above": 1, "looking up": 1, "male focus": 2, "messy hair": 1, "monochrome": 5, "open mouth": 46, "short hair": 3, "sleeveless": 1, "solo focus": 1, "spider web": 1, "suspenders": 1, "under tree": 1, "underwater": 1, "upper body": 8, "watercraft": 1, "closed eyes": 10, "expressions": 1, "fingernails": 1, "from behind": 2, "green shirt": 1, "holding cup": 1, "leg warmers": 4, "loose socks": 3, "motion blur": 1, "purple hair": 1, "speed lines": 1, "spiked hair": 3, "white dress": 2, "white shirt": 11, "against tree": 1, "broom riding": 5, "closed mouth": 7, "crossed arms": 1, "holding book": 3, "indian style": 1, "long sleeves": 8, "off shoulder": 2, "torn clothes": 2, "covering face": 1, "hands on hips": 2, "holding paper": 1, "holding sword": 1, "messenger bag": 1, "multiple boys": 1, "playing games": 1, "two-tone hair": 1, "bare shoulders": 2, "brown headwear": 1, "clenched teeth": 1, "holding weapon": 1, "multiple girls": 3, "multiple views": 1, "one eye closed": 2, "blue background": 2, "floating island": 1, "reference sheet": 1, "brown background": 1, "detached sleeves": 1, "hand on own chin": 1, "polka dot bikini": 2, "white background": 4, "blurry background": 1, "hand to own mouth": 1, "looking at viewer": 9, "multicolored hair": 1, "orange background": 1, "simple background": 5, "sleeves rolled up": 1, "v-shaped eyebrows": 1, "off-shoulder dress": 1, "looking to the side": 1}}, "sshs_legacy_hash": "091bd199", "ss_ip_noise_gamma": "None", "ss_network_module": "networks.lora", "ss_num_reg_images": "0", "ss_lr_warmup_steps": "0", "ss_max_train_steps": "740", "ss_mixed_precision": "bf16", "ss_network_dropout": "None", "ss_text_encoder_lr": "1.0", "ss_max_token_length": "225", "ss_num_train_images": "204", "ss_training_comment": "None", "modelspec.resolution": "1024x1024", "ss_new_sd_model_hash": "67ab2fd8ec439a89b3fedb15cc65f54336af163c7eb5e4f2acc98f090a29b0b3", "ss_prior_loss_weight": "1.0", "ss_zero_terminal_snr": "False", "ss_base_model_version": "sdxl_base_v1-0", "ss_scale_weight_norms": "None", "modelspec.architecture": "stable-diffusion-xl-v1-base/lora", "ss_debiased_estimation": "False", "ss_face_crop_aug_range": "None", "ss_training_started_at": "1726066908.2484195", "modelspec.encoder_layer": "2", "ss_adaptive_noise_scale": "None", "ss_caption_dropout_rate": "0.0", "ss_training_finished_at": "1726067863.29673", "modelspec.implementation": "https://github.com/Stability-AI/generative-models", "modelspec.sai_model_spec": "1.0.0", "ss_num_batches_per_epoch": "74", "modelspec.prediction_type": "epsilon", "ss_gradient_checkpointing": "True", "ss_sd_scripts_commit_hash": "f9317052edb4ab3b3c531ac3b28825ee78b4a966", "ss_multires_noise_discount": "0.3", "ss_caption_tag_dropout_rate": "0.0", "ss_multires_noise_iterations": "6", "ss_gradient_accumulation_steps": "1", "ss_caption_dropout_every_n_epochs": "0"}'
        : null, // headerData // TODO
      randw([
        { value: null, weight: 100 },
        { value: faker.word.noun(), weight: 1 },
      ]), // overrideName
    ];
    rows.push(row);
  }

  return { rows, currentId };
};

/**
 * ModelFile
 */
const genMFiles = (mvData: { id: number; uploadType: ModelUploadType }[]) => {
  const ret: (string | number | boolean | null)[][] = [];

  let step = 0;

  mvData.forEach((mv) => {
    const numFiles = randw([
      { value: 0, weight: 1 },
      { value: 1, weight: 16 },
      { value: 2, weight: 2 },
      { value: 3, weight: 1 },
    ]);

    if (numFiles > 0) {
      const { rows, currentId } = _genMFileData(numFiles, step, mv);
      ret.push(...rows);
      step = currentId;
    }
  });
  return ret;
};

/**
 * CoveredCheckpoint
 */
const genCoveredCheckpoints = (num: number, mvData: { id: number; modelId: number }[]) => {
  const ret = [];
  const remainingMvs = [...mvData];

  for (let step = 1; step <= num; step++) {
    if (!remainingMvs.length) break;
    const mvIndex = faker.number.int({ min: 0, max: remainingMvs.length - 1 });
    const mv = remainingMvs.splice(mvIndex, 1)[0];

    const row = [
      mv.modelId, // model_id
      mv.id, // version_id
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * ResourceReview
 */
const genReviews = (num: number, userIds: number[], mvData: { id: number; modelId: number }[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const isGood = fbool();
    const mv = rand(mvData);
    const existUsers = ret.filter((r) => r[1] === mv.id).map((r) => r[4] as number);

    const row = [
      step, // id
      mv.id, // modelVersionId
      isGood ? 5 : 1, // rating
      randw([
        { value: null, weight: 10 },
        { value: randPrependBad(faker.lorem.sentence()), weight: 1 },
      ]), // details
      rand(without(userIds, ...existUsers)), // userId
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      fbool(0.01), // exclude
      null, // metadata // TODO do we need things like "reviewIds" and "migrated"?
      mv.modelId, // modelId
      fbool(0.03), // nsfw
      fbool(0.01), // tosViolation
      isGood, // recommended
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * Tool
 */
const genTools = (num: number) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const name = faker.company.name();
    const page = faker.internet.url();

    const row = [
      step, // id
      name, // name
      null, // icon // TODO image
      created, // createdAt
      rand(Object.values(ToolType)), // type
      fbool(0.9), // enabled
      randw([
        { value: null, weight: 1 },
        {
          value:
            page +
            randw([
              { value: '', weight: 5 },
              { value: '/stuff', weight: 1 },
            ]),
          weight: 5,
        },
      ]), // domain
      randw([
        { value: null, weight: 1 },
        { value: faker.lorem.paragraph({ min: 1, max: 4 }), weight: 5 },
      ]), // description
      randw([
        { value: null, weight: 1 },
        { value: page, weight: 5 },
      ]), // homepage
      rand([null, name]), // company
      null, // priority
      '{}', // metadata
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * Technique
 */
const genTechniques = () => {
  return [
    [1, 'txt2img', '2024-05-20 22:00:06.478', true, 'Image'],
    [2, 'img2img', '2024-05-20 22:00:06.478', true, 'Image'],
    [3, 'inpainting', '2024-05-20 22:00:06.478', true, 'Image'],
    [4, 'workflow', '2024-05-20 22:00:06.478', true, 'Image'],
    [5, 'vid2vid', '2024-05-20 22:00:06.478', true, 'Video'],
    [6, 'txt2vid', '2024-05-20 22:00:06.478', true, 'Video'],
    [7, 'img2vid', '2024-05-20 22:00:06.478', true, 'Video'],
    [8, 'controlnet', '2024-06-04 16:31:37.241', true, 'Image'],
  ];
};

/**
 * Collection
 */
const genCollections = (num: number, userIds: number[], imageIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();

    const row = [
      step, // id
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      `${rand(['My', 'Some'])} ${randPrependBad(faker.word.adjective())} ${faker.word.noun()}s`, // name
      rand([null, '', randPrependBad(faker.lorem.sentence())]), // description
      rand(userIds), // userId
      fbool(0.95) ? 'Private' : rand(['Public', 'Review']), // write
      fbool(0.05) ? 'Unlisted' : rand(['Public', 'Private']), // read
      rand(Object.values(CollectionType).filter((ct) => ct !== 'Post')), // type // TODO add back post
      randw([
        { value: null, weight: 1000 },
        { value: rand(imageIds), weight: 1 },
      ]), // imageId
      fbool(0.4), // nsfw
      // randw([
      //   // { value: 'Bookmark', weight: 1000 }, // no need for this
      //   { value: null, weight: 100 },
      //   { value: 'Contest', weight: 1 },
      // ]), // mode
      null, // mode
      '{}', // metadata
      randw([
        { value: 'Public', weight: 10 },
        { value: 'Unsearchable', weight: 1 },
      ]), // availability
      randw([
        { value: 0, weight: 10 },
        { value: 31, weight: 4 },
        { value: 28, weight: 3 },
        { value: 1, weight: 2 },
        { value: 15, weight: 1 },
      ]), // nsfwLevel // TODO why are there values above 31?
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * CollectionItem
 */
const genCollectionItems = (
  num: number,
  collectionData: { id: number; type: CollectionType }[],
  articleIds: number[],
  postIds: number[],
  imageIds: number[],
  modelIds: number[],
  userIds: number[]
) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const collection = rand(collectionData);
    const status = randw([
      { value: 'ACCEPTED', weight: 10000 },
      { value: 'REJECTED', weight: 10 },
      { value: 'REVIEW', weight: 1 },
    ]);
    const isReviewed = fbool(0.001);
    const exist = ret.filter((r) => r[3] === collection.id);

    const row = [
      step, // id
      created, // createdAt
      rand([null, created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      collection.id, // collectionId
      collection.type === 'Article'
        ? rand(without(articleIds, ...exist.map((e) => e[4] as number)))
        : null, // articleId
      collection.type === 'Post'
        ? rand(without(postIds, ...exist.map((e) => e[5] as number)))
        : null, // postId
      collection.type === 'Image'
        ? rand(without(imageIds, ...exist.map((e) => e[6] as number)))
        : null, // imageId
      collection.type === 'Model'
        ? rand(without(modelIds, ...exist.map((e) => e[7] as number)))
        : null, // modelId
      rand([null, rand(userIds)]), // addedById
      null, // note
      status, // status
      null, // randomId
      isReviewed ? faker.date.between({ from: created, to: Date.now() }).toISOString() : null, // reviewedAt
      isReviewed ? rand(userIds) : null, // reviewedById
      null, // tagId
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * Post
 */
const genPosts = (
  num: number,
  userIds: number[],
  mvData: { id: number; modelId: number; userId?: number }[]
) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const isPublished = fbool(0.8);

    const mv = rand(mvData);
    const mvId = rand([null, mv.id]);
    const userId = mvId ? mv.userId ?? rand(userIds) : rand(userIds);

    const row = [
      step, // id
      fbool(0.4), // nsfw // 40% actually seems fair :/
      rand([
        null,
        `${randPrependBad(faker.word.adjective())} ${faker.word.adjective()} ${faker.word.noun()}`,
      ]), // title
      rand([null, `<p>${randPrependBad(faker.lorem.sentence())}</p>`]), // detail
      userId, // userId
      mvId, // modelVersionId
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      !isPublished ? null : faker.date.between({ from: created, to: Date.now() }).toISOString(), // publishedAt
      !isPublished ? null : `{"imageNsfwLevel": "${rand(Object.values(NsfwLevel))}"}`, // metadata
      fbool(0.01), // tosViolation
      null, // collectionId // TODO
      randw([
        { value: 'Public', weight: 30 },
        {
          value: rand(
            Object.values(Availability).filter((v) => !['Public', 'EarlyAccess'].includes(v))
          ),
          weight: 1,
        },
      ]), // availability
      fbool(0.01), // unlisted
      randw([
        { value: 0, weight: 1 },
        { value: 1, weight: 6 },
        { value: 4, weight: 2 },
        { value: 8, weight: 3 },
        { value: 16, weight: 4 },
      ]), // nsfwLevel
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * Image
 */
const genImages = (num: number, userIds: number[], postIds: number[]) => {
  const ret = [];

  // TODO try to use the s3 uploaded URLs

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const type = randw([
      { value: 'image', weight: 20 },
      { value: 'video', weight: 4 },
      // { value: 'audio', weight: 1 }, // not using audio
    ]);
    const mime = type === 'image' ? rand(IMAGE_MIME_TYPE) : rand(VIDEO_MIME_TYPE);
    const ext = mime.split('/').pop();
    const width = rand([128, 256, 512, 768, 1024, 1920]);
    const height = rand([128, 256, 512, 768, 1024, 1920]);
    const isGenned = fbool();
    const imageUrl = faker.image.url({ width, height });

    // TODO getting a proper blurhash sucks and nothing works
    // let hash = faker.string.sample(36);
    // hash = hash.replace(/[\\"']/g, '_');
    // const file = await getUrlAsFile(imageUrl);
    // const meta = file ? await preprocessFile(file) : null;
    const hash = null;

    const row = [
      `${capitalize(faker.word.adjective())}-${capitalize(
        faker.word.noun()
      )}-${faker.number.int()}.${ext ?? 'jpg'}`, // name
      imageUrl, // url
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      hash, // hash
      step, // id
      rand(userIds), // userId
      height, // height
      width, // width
      !isGenned
        ? null
        : `{"Size": "${width}x${height}", "seed": ${faker.string.numeric({
            length: 10,
            allowLeadingZeros: false,
          })}, "steps": ${faker.number.int(
            100
          )}, "prompt": "${faker.lorem.sentence()}", "sampler": "${rand(
            constants.samplers
          )}", "cfgScale": ${faker.number.int(10)}, "clipSkip": ${rand([
            0, 1, 2,
          ])}, "resources": ${randw([
            { value: '[]', weight: 5 },
            {
              value: `[{"name": "${faker.word.noun()}", "type": "lora", "weight": 0.95}]`,
              weight: 1,
            },
          ])}, "Created Date": "${created}", "negativePrompt": "bad stuff", "civitaiResources": [{"type": "checkpoint", "modelVersionId": 272376, "modelVersionName": "1.0"}]}`, // meta
      fbool(0.01), // tosViolation
      null, // analysis
      isGenned ? rand(Object.values(ImageGenerationProcess)) : null, // generationProcess
      null, // featuredAt
      fbool(0.05), // hideMeta
      faker.number.int(20), // index
      mime, // mimeType
      randw([
        { value: null, weight: 1 },
        { value: rand(postIds), weight: 10 },
      ]), // postId
      faker.date.between({ from: created, to: Date.now() }).toISOString(), // scanRequestedAt
      faker.date.between({ from: created, to: Date.now() }).toISOString(), // scannedAt
      null, // sizeKb
      rand(Object.values(NsfwLevel)), // nsfw
      null, // blockedFor
      'Scanned', // ingestion
      null, // needsReview
      type === 'image'
        ? `{"hash": "${hash}", "size": ${faker.number.int(
            1_000_000
          )}, "width": ${width}, "height": ${height}}`
        : `{"hash": "${hash}", "size": ${faker.number.int(
            1_000_000
          )}, "width": ${width}, "height": ${height}, "audio": ${fbool(
            0.2
          )}, "duration": ${faker.number.float(30)}}`, // metadata
      type, // type
      '{"wd14": "20279865", "scans": {"WD14": 1716391779426, "Rekognition": 1716391774556}, "rekognition": "20279864", "common-conversions": "20279863"}', // scanJobs
      randw([
        { value: 0, weight: 1 },
        { value: 1, weight: 6 },
        { value: 4, weight: 2 },
        { value: 8, weight: 3 },
        { value: 16, weight: 4 },
      ]), // nsfwLevel
      fbool(0.05), // nsfwLevelLocked
      randw([
        { value: 0, weight: 1 },
        { value: 1, weight: 6 },
        { value: 4, weight: 2 },
        { value: 8, weight: 3 },
        { value: 16, weight: 4 },
      ]), // aiNsfwLevel
      'urn:air:mixture:model:huggingface:Civitai/mixtureMovieRater', // aiModel
      created, // sortAt
      -1 * faker.number.int({ min: 1e12 }), // pHash // this is actually a bigInt but faker does weird stuff
      fbool(0.05), // minor
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * Article
 */
const genArticles = (num: number, userIds: number[], imageIds: number[]) => {
  const ret = [];

  let usableImageIds = imageIds;

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const status = randw([
      { value: 'Published', weight: 20 },
      { value: 'Draft', weight: 5 },
      { value: 'Unpublished', weight: 1 },
    ]);
    const coverId = rand(usableImageIds);
    usableImageIds = without(usableImageIds, coverId);

    const row = [
      step, // id
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      fbool(0.2), // nsfw
      fbool(0.01), // tosViolation
      null, // metadata
      randPrependBad(faker.lorem.sentence()), // title
      `<p>${randPrependBad(faker.lorem.paragraphs({ min: 1, max: 10 }, '<br/>'))}</p>`, // content
      rand([null, '']), // cover // TODO with images
      status === 'Published'
        ? faker.date.between({ from: created, to: Date.now() }).toISOString()
        : null, // publishedAt
      rand(userIds), // userId
      randw([
        { value: 'Public', weight: 30 },
        {
          value: rand(
            Object.values(Availability).filter((v) => !['Public', 'EarlyAccess'].includes(v))
          ),
          weight: 1,
        },
      ]), // availability
      fbool(0.01), // unlisted
      coverId, // coverId
      randw([
        { value: 0, weight: 1 },
        { value: 1, weight: 4 },
        { value: 28, weight: 3 },
        { value: 15, weight: 2 },
        { value: 31, weight: 2 },
      ]), // nsfwLevel
      randw([
        { value: 0, weight: 6 },
        { value: 1, weight: 4 },
        { value: 28, weight: 3 },
        { value: 15, weight: 2 },
        { value: 31, weight: 2 },
      ]), // userNsfwLevel
      randw([
        { value: '{}', weight: 6 },
        { value: '{userNsfwLevel}', weight: 1 },
      ]), // lockedProperties
      status, // status
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * ImageTool
 */
const genImageTools = (num: number, imageIds: number[], toolIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const imageId = rand(imageIds);
    const existTools: number[] = ret.filter((r) => r[0] === imageId).map((r) => r[1] as number);
    const toolId = rand(without(toolIds, ...existTools));

    const row = [
      imageId, // imageId
      toolId, // toolId
      null, // notes
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * ImageTechnique
 */
const genImageTechniques = (num: number, imageIds: number[], techniqueIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const imageId = rand(imageIds);
    const existTechs: number[] = ret.filter((r) => r[0] === imageId).map((r) => r[1] as number);
    const techId = rand(without(techniqueIds, ...existTechs));

    const row = [
      imageId, // imageId
      techId, // techniqueId
      randw([
        { value: null, weight: 20 },
        { value: faker.lorem.sentence(), weight: 1 },
      ]), // notes
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

const genTags = (num: number) => {
  const ret = [
    [
      'anime',
      null,
      '2023-02-18 02:41:35.011',
      '2023-03-11 08:58:19.316',
      1,
      '{Model,Question,Image,Post}',
      false,
      true,
      false,
      'Label',
      'None',
      false,
      1,
    ],
    [
      'woman',
      null,
      '2023-02-17 18:05:45.976',
      '2023-05-02 05:15:29.764',
      2,
      '{Model,Image,Post,Question}',
      false,
      true,
      false,
      'Label',
      'None',
      false,
      1,
    ],
    [
      'photography',
      null,
      '2023-02-17 18:42:12.828',
      '2024-01-18 21:42:41.591',
      3,
      '{Model,Image,Post,Question}',
      false,
      true,
      false,
      'Label',
      'None',
      false,
      1,
    ],
    [
      'celebrity',
      null,
      '2023-02-17 18:42:12.828',
      '2023-03-03 22:03:56.586',
      4,
      '{Model,Image,Question,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'subject',
      null,
      '2022-11-12 21:57:05.708',
      '2022-11-12 21:57:05.708',
      5,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'hentai',
      null,
      '2023-02-17 18:42:12.828',
      '2023-02-17 18:42:12.828',
      6,
      '{Model,Image,Post}',
      false,
      true,
      true,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'character',
      null,
      '2023-02-18 02:41:35.011',
      '2023-02-18 02:55:57.727',
      7,
      '{Model,Question,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'porn',
      null,
      '2023-02-17 19:02:56.629',
      '2023-02-17 19:02:56.629',
      8,
      '{Model,Image,Post}',
      false,
      true,
      true,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'animals',
      null,
      '2022-11-04 17:59:01.748',
      '2022-11-04 17:59:01.748',
      9,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'retro',
      null,
      '2022-11-30 09:51:50.239',
      '2022-11-30 09:51:50.239',
      10,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'food',
      null,
      '2023-02-11 12:49:13.847',
      '2023-03-11 09:35:57.749',
      11,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'Label',
      'None',
      false,
      1,
    ],
    [
      '3d',
      null,
      '2022-11-04 19:46:47.389',
      '2022-11-04 19:46:47.389',
      12,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'scifi',
      null,
      '2022-12-26 03:02:24.520',
      '2022-12-26 03:02:24.520',
      13,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'graphic design',
      null,
      '2023-02-17 03:23:59.457',
      '2023-02-17 03:23:59.457',
      14,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'landscapes',
      null,
      '2022-11-04 17:36:59.422',
      '2022-11-04 17:36:59.422',
      15,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'man',
      null,
      '2023-02-17 18:42:12.828',
      '2023-03-11 08:42:56.790',
      16,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'Label',
      'None',
      false,
      1,
    ],
    [
      'meme',
      null,
      '2022-11-30 02:50:49.164',
      '2023-11-18 12:02:18.061',
      17,
      '{Model,Image,Post,Question}',
      false,
      true,
      true,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'video game',
      null,
      '2023-02-17 18:42:12.828',
      '2023-02-17 18:42:12.828',
      18,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'furry',
      null,
      '2023-02-17 18:12:44.997',
      '2023-02-17 18:12:44.997',
      19,
      '{Model,Image,Post}',
      false,
      true,
      true,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'groteseque',
      null,
      '2023-02-17 18:42:12.828',
      '2023-02-17 18:42:12.828',
      20,
      '{Model,Image,Post}',
      false,
      true,
      true,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'illustration',
      null,
      '2023-02-17 18:13:02.026',
      '2023-02-17 18:13:02.026',
      21,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'fantasy',
      null,
      '2023-02-17 18:42:12.828',
      '2023-02-17 18:42:12.828',
      22,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'architecture',
      null,
      '2022-12-15 01:17:05.065',
      '2023-03-11 09:20:31.396',
      23,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'Label',
      'None',
      false,
      1,
    ],
    [
      'horror',
      null,
      '2022-11-09 23:08:24.969',
      '2022-11-09 23:08:24.969',
      24,
      '{Model,Image,Post}',
      false,
      true,
      true,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'cartoon',
      null,
      '2023-02-17 18:42:12.828',
      '2023-03-11 09:43:10.712',
      25,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'Label',
      'None',
      false,
      1,
    ],
    [
      'cars',
      null,
      '2023-02-17 18:42:12.828',
      '2023-02-17 18:42:12.828',
      26,
      '{Model,Image,Post}',
      false,
      true,
      false,
      'UserGenerated',
      'None',
      false,
      1,
    ],
    [
      'image category',
      null,
      '2023-03-24 23:13:52.715',
      '2023-03-24 23:13:52.715',
      27,
      '{Tag}',
      false,
      false,
      false,
      'System',
      'None',
      false,
      1,
    ],
    [
      'model category',
      null,
      '2023-03-24 23:13:52.715',
      '2023-03-24 23:13:52.715',
      28,
      '{Tag}',
      false,
      false,
      false,
      'System',
      'None',
      false,
      1,
    ],
    [
      'post category',
      null,
      '2023-03-24 23:13:52.715',
      '2023-03-24 23:13:52.715',
      29,
      '{Tag}',
      false,
      false,
      false,
      'System',
      'None',
      false,
      1,
    ],
    [
      'contest',
      null,
      '2023-05-03 16:54:55.704',
      '2023-12-02 11:35:33.324',
      30,
      '{Tag,Post,Question}',
      false,
      false,
      false,
      'System',
      'None',
      false,
      1,
    ],
    [
      'article category',
      null,
      '2023-05-12 21:43:26.532',
      '2023-05-12 21:43:26.532',
      31,
      '{Tag}',
      false,
      false,
      false,
      'System',
      'None',
      false,
      1,
    ],
  ];

  const retLen = ret.length;
  const seenNames = ret.map((r) => r[0] as string);

  for (let step = retLen + 1; step <= retLen + num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    let name = rand([faker.word.noun(), `${faker.word.adjective()} ${faker.word.noun()}`]);
    if (seenNames.includes(name)) name = `${name} ${faker.number.int(1_000)}`;
    seenNames.push(name);

    const row = [
      name, // name
      null, // color
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      step, // id
      randw([
        { value: '{Image,Model,Post}', weight: 1 },
        { value: '{Post}', weight: 10 },
        { value: '{Model,Post}', weight: 5 },
        { value: '{Model}', weight: 5 },
        { value: '{Image}', weight: 2 },
      ]), // target
      fbool(0.001), // unlisted
      false, // isCategory
      fbool(0.001), // unfeatured
      randw([
        { value: TagType.System, weight: 5 },
        { value: TagType.Moderation, weight: 30 },
        { value: TagType.Label, weight: 7500 },
        { value: TagType.UserGenerated, weight: 150000 },
      ]), // type
      'None', // nsfw
      false, // adminOnly
      1, // nsfwLevel
    ];

    ret.push(row);
  }
  return ret;
};

/*
 * TagsOnTags
 */
const genTagsOnTags = (num: number, tagIds: number[]) => {
  const ret = [];

  for (const tagId of [27, 28, 29, 31]) {
    const created = faker.date.past({ years: 3 }).toISOString();
    let allowedTags = tagIds.filter((t) => t !== tagId);

    for (let step = 1; step <= num; step++) {
      const randTag = rand(allowedTags);
      const row = [
        tagId, // fromTagId
        randTag, // toTagId
        created, // createdAt
        'Parent', // type
      ];
      allowedTags = allowedTags.filter((t) => t !== randTag);

      ret.push(row);
    }
  }
  return ret;
};

// TODO these tags should probably be looking at the "target"

/**
 * TagsOnArticle
 */
const genTagsOnArticles = (num: number, tagIds: number[], articleIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const articleId = rand(articleIds);
    const existTags = ret.filter((r) => (r[0] as number) === articleId).map((r) => r[1] as number);

    const row = [
      articleId, // articleId
      rand(without(tagIds, ...existTags)), // tagId
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * TagsOnPost
 */
const genTagsOnPosts = (num: number, tagIds: number[], postIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const postId = rand(postIds);
    const existTags = ret.filter((r) => (r[0] as number) === postId).map((r) => r[1] as number);

    const row = [
      postId, // postId
      rand(without(tagIds, ...existTags)), // tagId
      created, // createdAt
      null, // confidence
      false, // disabled
      false, // needsReview
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * TagsOnImageNew
 */
const genTagsOnImages = (num: number, tagIds: number[], imageIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    const imageId = rand(imageIds);
    const existTags = ret.filter((r) => (r[0] as number) === imageId).map((r) => r[1] as number);

    const row = [
      imageId, // imageId
      rand(without(tagIds, ...existTags)), // tagId
      rand([18502, 10340, 10339, 10310, 14433, 14432, 10332, 10334]), // attributes // TODO, honestly, this is the best i got
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * TagsOnModels
 */
const genTagsOnModels = (num: number, tagIds: number[], modelIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const modelId = rand(modelIds);
    const existTags = ret.filter((r) => (r[0] as number) === modelId).map((r) => r[1] as number);

    const row = [
      modelId, // modelId
      rand(without(tagIds, ...existTags)), // tagId
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * Comment
 */
const genCommentsModel = (
  num: number,
  userIds: number[],
  modelIds: number[],
  parentIds: number[],
  doThread = false,
  startId = 0
) => {
  const ret = [];

  for (let step = startId + 1; step <= startId + num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();

    const row = [
      step, // id
      `<p>${randPrependBad(faker.lorem.paragraph({ min: 1, max: 8 }))}</p>`, // content
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      fbool(0.01), // nsfw
      fbool(0.01), // tosViolation
      doThread ? rand(parentIds) : null, // parentId
      rand(userIds), // userId
      rand(modelIds), // modelId
      fbool(0.01), // locked
      fbool(0.01), // hidden
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * Thread
 */
const genThreads = (
  num: number,
  imageIds: number[],
  postIds: number[],
  reviewIds: number[],
  articleIds: number[],
  commentIds: number[],
  parentIds: number[],
  doThread = false,
  startId = 0
) => {
  const ret = [];

  const seenImageIds: number[] = [];
  const seenPostIds: number[] = [];
  const seenReviewIds: number[] = [];
  const seenArticleIds: number[] = [];

  const parentIdxs = range(parentIds.length);

  for (let step = startId + 1; step <= startId + num; step++) {
    const type = rand(['image', 'post', 'review', 'article']); // TODO bounty, bountyEntry

    const imageId = type === 'image' && !doThread ? rand(without(imageIds, ...seenImageIds)) : null;
    const postId = type === 'post' && !doThread ? rand(without(postIds, ...seenPostIds)) : null;
    const reviewId =
      type === 'review' && !doThread ? rand(without(reviewIds, ...seenReviewIds)) : null;
    const articleId =
      type === 'article' && !doThread ? rand(without(articleIds, ...seenArticleIds)) : null;

    const parentIdx = doThread ? rand(parentIdxs) : 0;
    if (doThread) pull(parentIdxs, parentIdx);
    const parentId = doThread ? parentIds[parentIdx] : null;
    const commentId = doThread ? commentIds[parentIdx] : null;

    if (imageId) seenImageIds.push(imageId);
    if (postId) seenPostIds.push(postId);
    if (reviewId) seenReviewIds.push(reviewId);
    if (articleId) seenArticleIds.push(articleId);

    const row = [
      step, // id
      fbool(0.01), // locked
      null, // questionId
      null, // answerId
      imageId, // imageId
      postId, // postId
      reviewId, // reviewId
      '{}', // metadata // TODO do we need "reviewIds" here?
      null, // modelId
      commentId, // commentId
      articleId, // articleId
      null, // bountyEntryId // TODO
      null, // bountyId // TODO
      null, // clubPostId
      parentId, // parentThreadId
      parentId, // rootThreadId
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * CommentV2
 */
const genCommentsV2 = (num: number, userIds: number[], threadIds: number[], startId = 0) => {
  const ret = [];

  for (let step = startId + 1; step <= startId + num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();

    const row = [
      step, // id
      `<p>${randPrependBad(faker.lorem.paragraph({ min: 1, max: 8 }))}</p>`, // content
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      fbool(0.01), // nsfw
      fbool(0.01), // tosViolation
      rand(userIds), // userId
      rand(threadIds), // threadId
      null, // metadata // TODO need "oldId"?
      fbool(0.005), // hidden
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * ImageResource
 */
const genImageResources = (num: number, mvIds: number[], imageIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const isModel = fbool(0.9);

    const row = [
      step, // id
      isModel ? rand(mvIds) : null, // modelVersionId
      isModel
        ? rand(['lora', 'checkpoint', 'embed', null])
        : `${faker.word.adjective()}_${faker.word.noun()}`, // name
      rand(imageIds), // imageId
      fbool(0.95), // detected
      randw([
        { value: null, weight: 9 },
        {
          value: faker.string.hexadecimal({
            length: 12,
            casing: 'lower',
            prefix: '',
          }),
          weight: 1,
        },
      ]), // hash
      randw([
        { value: null, weight: 1 },
        { value: faker.number.int(100), weight: 12 },
      ]), // strength
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * ArticleEngagement
 */
const genArticleEngagements = (num: number, userIds: number[], articleIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();
    const userId = rand(userIds);
    const existIds = ret.filter((r) => (r[0] as number) === userId).map((r) => r[1] as number);

    const row = [
      userId, // userId
      rand(without(articleIds, ...existIds)), // articleId
      rand(Object.values(ArticleEngagementType)), // type
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * ImageEngagement
 */
const genImageEngagements = (num: number, userIds: number[], imageIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();
    const userId = rand(userIds);
    const existIds = ret.filter((r) => (r[0] as number) === userId).map((r) => r[1] as number);

    const row = [
      userId, // userId
      rand(without(imageIds, ...existIds)), // imageId
      rand(Object.values(ImageEngagementType)), // type
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * ModelEngagement
 */
const genModelEngagements = (num: number, userIds: number[], modelIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();
    const userId = rand(userIds);
    const existIds = ret.filter((r) => (r[0] as number) === userId).map((r) => r[1] as number);

    const row = [
      userId, // userId
      rand(without(modelIds, ...existIds)), // modelId
      rand(Object.values(ModelEngagementType)), // type
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * ModelVersionEngagement
 */
const genModelVersionEngagements = (num: number, userIds: number[], mvIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();
    const userId = rand(userIds);
    const existIds = ret.filter((r) => (r[0] as number) === userId).map((r) => r[1] as number);

    const row = [
      userId, // userId
      rand(without(mvIds, ...existIds)), // modelVersionId
      rand(Object.values(ModelVersionEngagementType)), // type
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * TagEngagement
 */
const genTagEngagements = (num: number, userIds: number[], tagIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();
    const userId = rand(userIds);
    const existIds = ret.filter((r) => (r[0] as number) === userId).map((r) => r[1] as number);

    const row = [
      userId, // userId
      rand(without(tagIds, ...existIds)), // tagId
      rand(Object.values(TagEngagementType)), // type
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * UserEngagement
 */
const genUserEngagements = (num: number, userIds: number[], targetUserIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();
    const userId = rand(userIds);
    const existIds = ret.filter((r) => (r[0] as number) === userId).map((r) => r[1] as number);

    const row = [
      userId, // userId
      rand(without(targetUserIds, ...existIds)), // targetUserId
      rand(Object.values(UserEngagementType)), // type
      created, // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

const reactions = Object.values(ReviewReactions).filter((r) => r !== 'Dislike');

/**
 * ArticleReaction
 */
const genArticleReactions = (num: number, userIds: number[], articleIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();

    const row = [
      step, // id
      rand(articleIds), // articleId
      rand(userIds), // userId
      rand(reactions), // reaction
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * CommentReaction
 */
const genCommentReactions = (num: number, userIds: number[], commentIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();

    const row = [
      step, // id
      rand(commentIds), // commentId
      rand(userIds), // userId
      rand(reactions), // reaction
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * CommentV2Reaction
 */
const genCommentV2Reactions = (num: number, userIds: number[], commentIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();

    const row = [
      step, // id
      rand(commentIds), // commentId
      rand(userIds), // userId
      rand(reactions), // reaction
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * ImageReaction
 */
const genImageReactions = (num: number, userIds: number[], imageIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();

    const row = [
      step, // id
      rand(imageIds), // imageId
      rand(userIds), // userId
      rand(reactions), // reaction
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * PostReaction
 */
const genPostReactions = (num: number, userIds: number[], postIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    // nb not quite right, would need created of entity, but being lazy here
    const created = faker.date.past({ years: 3 }).toISOString();

    const row = [
      step, // id
      rand(postIds), // postId
      rand(userIds), // userId
      rand(reactions), // reaction
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * HomeBlock
 */
const genHomeBlocks = (collectionData: { id: number; type: CollectionType }[]) => {
  // id, "createdAt", "updatedAt", "userId", metadata, index, type, permanent, "sourceId"

  const collectModel = collectionData.filter((c) => c.type === 'Model').map((c) => c.id);
  const collectImage = collectionData.filter((c) => c.type === 'Image').map((c) => c.id);
  const collectPost = collectionData.filter((c) => c.type === 'Post').map((c) => c.id);
  const collectArticle = collectionData.filter((c) => c.type === 'Article').map((c) => c.id);

  if (!collectModel.length) collectModel.push(1);
  if (!collectImage.length) collectImage.push(1);
  if (!collectPost.length) collectPost.push(1);
  if (!collectArticle.length) collectArticle.push(1);

  return [
    [
      2,
      '2023-07-25 18:13:12.053',
      null,
      -1,
      '{"title": "Announcements", "announcements": {"limit": 4}}',
      -1,
      'Announcement',
      true,
      null,
    ],
    [
      1,
      '2023-07-25 18:13:12.053',
      null,
      -1,
      `{"link": "/models", "title": "Featured Models", "linkText": "Explore all models", "withIcon": true, "collection": {"id": ${rand(
        collectModel
      )}, "rows": 2, "limit": 8}, "description": "A filtered list of all models on the site, to view the complete model list click Explore All Models."}`,
      3,
      'Collection',
      false,
      null,
    ],
    [
      3,
      '2023-07-25 18:13:12.053',
      null,
      -1,
      `{"link": "/images", "title": "Featured Images", "linkText": "Explore all images", "withIcon": true, "collection": {"id": ${rand(
        collectImage
      )}, "rows": 2, "limit": 8}, "description": "All sorts of cool pictures created by our community, from simple shapes to detailed landscapes or human faces. A virtual canvas where you can unleash your creativity or get inspired."}`,
      1,
      'Collection',
      false,
      null,
    ],
    [
      5,
      '2023-07-25 18:13:12.053',
      null,
      -1,
      `{"link": "/posts", "title": "Featured Posts", "linkText": "Explore all posts", "withIcon": true, "collection": {"id": ${rand(
        collectPost
      )}, "limit": 8}, "description": "Find groups of pictures created by our community, using specific models."}`,
      7,
      'Collection',
      false,
      null,
    ],
    [
      6,
      '2023-07-25 18:13:12.053',
      null,
      -1,
      `{"link": "/articles", "title": "Featured Articles", "linkText": "Explore all articles", "withIcon": true, "collection": {"id": ${rand(
        collectArticle
      )}, "limit": 8}, "description": "Find information, guides and tutorials, analysis on particular topics and much more. From the community, for the community."}`,
      8,
      'Collection',
      false,
      null,
    ],
    [
      7, // id
      '2025-03-20 18:13:12.053', // createdAt
      null, // updatedAt
      -1, // userId
      `{"title": "Featured Models", "description": "A list of all featured models on the site."}`, // meta
      4, // index
      'FeaturedModelVersion', // type
      false, // permanent
      null, // sourceId
    ],
  ];
};

/**
 * Leaderboard
 */
const genLeaderboards = () => {
  // id, index, title, description, "scoringDescription", query, active, public

  return [
    [
      'overall',
      1,
      'Creators',
      'Top model creators in the community',
      `√((downloads/10) +
(likes * 3) +
(generations/100))
---
Only models without mature cover images are considered
Diminishing returns up to 120 entries`,
      // language=text
      `WITH entries AS (
	SELECT
		m."userId",
		( -- Points
			(mvm."downloadCount" / 10) +
			(mvm."thumbsUpCount" * 3) +
			(mvm."generationCount" / 100)
		) * ( -- Age
		  1 - (1 * (EXTRACT(DAY FROM (now() - mv."publishedAt"))/30)^2)
		) as score,
		mvm."thumbsUpCount",
		mvm."generationCount",
		mvm."downloadCount",
		mv."publishedAt"
	FROM "ModelVersionMetric" mvm
	JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
	JOIN "Model" m ON mv."modelId" = m.id
	WHERE
	  mv."publishedAt" > current_date - INTERVAL '30 days'
	  AND mvm.timeframe = 'Month'
	  AND mv.status = 'Published'
	  AND m.status = 'Published'
	  AND (mv.meta->>'imageNsfwLevel')::int < 4
), entries_ranked AS (
	SELECT
		*,
		row_number() OVER (PARTITION BY "userId" ORDER BY score DESC) rank
	FROM entries
), entries_multiplied AS (
  SELECT
    *,
    GREATEST(0, 1 - (rank/120::double precision)^0.5) as quantity_multiplier
  FROM entries_ranked
), scores AS (
	SELECT
	  "userId",
	  sqrt(SUM(score * quantity_multiplier)) * 1000 score,
	  jsonb_build_object(
	    'thumbsUpCount', SUM("thumbsUpCount"),
	    'generationCount', SUM("generationCount"),
	    'downloadCount', SUM("downloadCount"),
	    'entries', COUNT(*)
		) metrics
	FROM entries_multiplied er
	JOIN "User" u ON u.id = er."userId"
	WHERE u."deletedAt" IS NULL AND u.id > 0
	GROUP BY "userId"
)`,
      true,
      true,
    ],
    [
      'overall_90',
      2,
      'Creators (90 Days)',
      'Top model creators in the community over the last 90 days',
      `√((downloads/10) +
(likes * 3) +
(generations/100))
---
Only models without mature cover images are considered
Diminishing returns up to 120 entries
This leaderboard is experimental and temporary`,
      // language=text
      `WITH entries AS (
	SELECT
		m."userId",
		( -- Points
			(mvm."downloadCount" / 10) +
			(mvm."thumbsUpCount" * 3) +
			(mvm."generationCount" / 100)
		) * ( -- Age
			-0.1 + ((1+0.1)/(1+(EXTRACT(DAY FROM (now() - mv."publishedAt"))/40.03)^2.71))
		) as score,
		EXTRACT(DAY FROM (now() - mv."publishedAt")) as days,
		mvm."thumbsUpCount",
		mvm."generationCount",
		mvm."downloadCount",
		mv."publishedAt"
	FROM "ModelVersionMetric" mvm
	JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
	JOIN "Model" m ON mv."modelId" = m.id
	WHERE
	  mv."publishedAt" BETWEEN current_date - INTERVAL '90 days' AND now()
	  AND mvm.timeframe = 'AllTime'
	  AND mv.status = 'Published'
	  AND m.status = 'Published'
	  AND (mv.meta->>'imageNsfwLevel')::int < 4
), entries_ranked AS (
	SELECT
		*,
		row_number() OVER (PARTITION BY "userId" ORDER BY score DESC) rank
	FROM entries
), entries_multiplied AS (
  SELECT
    *,
    GREATEST(0, 1 - (rank/120::double precision)^0.5) as quantity_multiplier
  FROM entries_ranked
), scores AS (
	SELECT
	  "userId",
	  sqrt(SUM(score * quantity_multiplier)) * 1000 score,
	  jsonb_build_object(
	    'thumbsUpCount', SUM("thumbsUpCount"),
	    'generationCount', SUM("generationCount"),
	    'downloadCount', SUM("downloadCount"),
	    'entries', COUNT(*)
		) metrics
	FROM entries_multiplied er
	JOIN "User" u ON u.id = er."userId"
	WHERE u."deletedAt" IS NULL AND u.id > 0
	GROUP BY "userId"
)`,
      true,
      true,
    ],
    [
      'overall_nsfw',
      3,
      'Creators (mature)',
      'Top model creators in the community',
      `√((downloads/10) +
(likes * 3) +
(generations/100))
---
Diminishing returns up to 120 entries`,
      // language=text
      `WITH entries AS (
	SELECT
		m."userId",
		( -- Points
			(mvm."downloadCount" / 10) +
			(mvm."thumbsUpCount" * 3) +
			(mvm."generationCount" / 100)
		) * ( -- Age
		  1 - (1 * (EXTRACT(DAY FROM (now() - mv."publishedAt"))/30)^2)
		) as score,
		mvm."thumbsUpCount",
		mvm."generationCount",
		mvm."downloadCount",
		mv."publishedAt"
	FROM "ModelVersionMetric" mvm
	JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
	JOIN "Model" m ON mv."modelId" = m.id
	WHERE
	  mv."publishedAt" > current_date - INTERVAL '30 days'
	  AND mvm.timeframe = 'Month'
	  AND mv.status = 'Published'
	  AND m.status = 'Published'
), entries_ranked AS (
	SELECT
		*,
		row_number() OVER (PARTITION BY "userId" ORDER BY score DESC) rank
	FROM entries
), entries_multiplied AS (
  SELECT
    *,
    GREATEST(0, 1 - (rank/120::double precision)^0.5) as quantity_multiplier
  FROM entries_ranked
), scores AS (
	SELECT
	  "userId",
	  sqrt(SUM(score * quantity_multiplier)) * 1000 score,
	  jsonb_build_object(
	    'thumbsUpCount', SUM("thumbsUpCount"),
	    'generationCount', SUM("generationCount"),
	    'downloadCount', SUM("downloadCount"),
	    'entries', COUNT(*)
		) metrics
	FROM entries_multiplied er
	JOIN "User" u ON u.id = er."userId"
	WHERE u."deletedAt" IS NULL AND u.id > 0
	GROUP BY "userId"
)`,
      true,
      true,
    ],
    [
      'new_creators',
      4,
      'New Creators',
      'Top new creators this month',
      `√((downloads/10) +
(likes * 3) +
(generations/100))
---
Only models without mature cover images are considered
Diminishing returns up to 120 entries
First model added in the last 30 days`,
      // language=text
      `WITH entries AS (
	SELECT
		m."userId",
		( -- Points
			(mvm."downloadCount" / 10) +
			(mvm."thumbsUpCount" * 3) +
			(mvm."generationCount" / 100)
		) * ( -- Age
		  1 - (1 * (EXTRACT(DAY FROM (now() - mv."publishedAt"))/30)^2)
		) as score,
		mvm."thumbsUpCount",
		mvm."generationCount",
		mvm."downloadCount",
		mv."publishedAt"
	FROM "ModelVersionMetric" mvm
	JOIN "ModelVersion" mv ON mv.id = mvm."modelVersionId"
	JOIN "Model" m ON mv."modelId" = m.id
	WHERE
	  mv."publishedAt" > current_date - INTERVAL '30 days'
	  AND mvm.timeframe = 'Month'
	  AND mv.status = 'Published'
	  AND m.status = 'Published'
	  AND (mv.meta->>'imageNsfwLevel')::int < 4
		AND NOT EXISTS (
			SELECT 1 FROM "Model" mo
			WHERE
				mo."userId" = m."userId"
				AND mo."publishedAt" < current_date - INTERVAL '31 days'
		)
), entries_ranked AS (
	SELECT
		*,
		row_number() OVER (PARTITION BY "userId" ORDER BY score DESC) rank
	FROM entries
), entries_multiplied AS (
  SELECT
    *,
    GREATEST(0, 1 - (rank/120::double precision)^0.5) as quantity_multiplier
  FROM entries_ranked
), scores AS (
	SELECT
	  "userId",
	  sqrt(SUM(score * quantity_multiplier)) * 1000 score,
	  jsonb_build_object(
	    'thumbsUpCount', SUM("thumbsUpCount"),
	    'generationCount', SUM("generationCount"),
	    'downloadCount', SUM("downloadCount"),
	    'entries', COUNT(*)
		) metrics
	FROM entries_multiplied er
	JOIN "User" u ON u.id = er."userId"
	WHERE u."deletedAt" IS NULL AND u.id > 0
	GROUP BY "userId"
)`,
      true,
      true,
    ],
  ];
};

/**
 * AuctionBase
 */
const genAuctionBases = () => {
  return [
    [
      1, // id
      'Model', // type
      null, // ecosystem
      'Featured Checkpoints', // name
      40, // quantity
      1000, // minPrice
      true, // active
      'featured-checkpoints', // slug
      7, // runForDays
      7, // validForDays
      null, // description
    ],
    [
      2, // id
      'Model', // type
      'Pony', // ecosystem
      'Featured Resources - Pony', // name
      20, // quantity
      500, // minPrice
      true, // active
      'featured-resources-pony', // slug
      1, // runForDays
      1, // validForDays
      null, // description
    ],
    [
      3, // id
      'Model', // type
      'Illustrious', // ecosystem
      'Featured Resources - Illustrious', // name
      20, // quantity
      500, // minPrice
      false, // active
      'featured-resources-illustrious', // slug
      1, // runForDays
      1, // validForDays
      null, // description
    ],
    [
      4, // id
      'Model', // type
      'Flux1', // ecosystem
      'Featured Resources - Flux', // name
      10, // quantity
      200, // minPrice
      true, // active
      'featured-resources-flux', // slug
      1, // runForDays
      1, // validForDays
      null, // description
    ],
    [
      5, // id
      'Model', // type
      'SDXL', // ecosystem
      'Featured Resources - SDXL', // name
      40, // quantity
      500, // minPrice
      true, // active
      'featured-resources-sdxl', // slug
      1, // runForDays
      1, // validForDays
      null, // description
    ],
    [
      6, // id
      'Model', // type
      'SD1', // ecosystem
      'Featured Resources - SD1', // name
      40, // quantity
      500, // minPrice
      true, // active
      'featured-resources-sd1', // slug
      1, // runForDays
      1, // validForDays
      null, // description
    ],
    [
      7, // id
      'Model', // type
      'Misc', // ecosystem
      'Featured Resources - Misc', // name
      40, // quantity
      500, // minPrice
      true, // active
      'featured-resources-misc', // slug
      1, // runForDays
      1, // validForDays
      'For generic model types that do not have a defined ecosystem.', // description
    ],
  ];
};

/**
 * Auction
 */
const genAuctions = (auctionBaseIds: number[]) => {
  const ret: (number | boolean | null | string)[][] = [];
  let step = 1;
  const now = dayjs();

  // for each auction base, create an auction from yesterday, today, and tomorrow
  for (const abi of auctionBaseIds) {
    ret.push(
      [
        step, // id
        now.subtract(1, 'day').startOf('day').format(), // startAt
        now.startOf('day').format(), // endAt
        rand([20, 30, 40]), // quantity
        rand([200, 500, 1000]), // minPrice
        abi, // auctionBaseId
        now.startOf('day').format(), // validFrom
        now.add(1, 'day').startOf('day').format(), // validTo
        true, // finalized
      ],
      [
        step + 1, // id
        now.startOf('day').format(), // startAt
        now.add(1, 'day').startOf('day').format(), // endAt
        rand([20, 30, 40]), // quantity
        rand([200, 500, 1000]), // minPrice
        abi, // auctionBaseId
        now.add(1, 'day').startOf('day').format(), // validFrom
        now.add(2, 'day').startOf('day').format(), // validTo
        false, // finalized
      ],
      [
        step + 2, // id
        now.add(1, 'day').startOf('day').format(), // startAt
        now.add(2, 'day').startOf('day').format(), // endAt
        rand([20, 30, 40]), // quantity
        rand([200, 500, 1000]), // minPrice
        abi, // auctionBaseId
        now.add(2, 'day').startOf('day').format(), // validFrom
        now.add(3, 'day').startOf('day').format(), // validTo
        false, // finalized
      ]
    );
    step += 3;
  }
  return ret;
};

/**
 * Bid
 */
const genBids = (num: number, auctionIds: number[], userIds: number[], modelIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    // not quite right, but whatever
    const created = faker.date.recent({ days: 2 }).toISOString();

    const row = [
      step, // id
      rand(auctionIds), // auctionId
      rand(userIds), // userId
      rand(modelIds), // entityId
      faker.number.int({ min: 1, max: 5_000 }), // amount
      created, // createdAt
      fbool(0.05), // deleted
      fbool(0.1), // fromRecurring
      fbool(0.05), // isRefunded
      `{}`, // transactionIds, ${faker.string.uuid()}, probably dont want these since we can't refund them
    ];

    ret.push(row);
  }

  return ret;
};

/**
 * BidRecurring
 */
const genBidRecurrings = (
  num: number,
  auctionBaseIds: number[],
  userIds: number[],
  modelIds: number[]
) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    // not quite right, but whatever
    const created = faker.date.recent({ days: 3 });

    const row = [
      step, // id
      rand(userIds), // userId
      rand(modelIds), // entityId
      faker.number.int({ min: 1, max: 5_000 }), // amount
      created.toISOString(), // createdAt
      created.toISOString(), // startAt
      dayjs(created)
        .add(faker.number.int({ min: 1, max: 10 }), 'day')
        .startOf('day')
        .format(), // endAt
      rand(auctionBaseIds), // auctionBaseId
      fbool(0.05), // isPaused
    ];

    ret.push(row);
  }

  return ret;
};

/**
 * FeaturedModelVersion
 */
const genFeaturedModelVersions = (num: number, mvIds: number[]) => {
  const ret = [];

  let usableMvIds = mvIds;

  for (let step = 1; step <= num; step++) {
    if (!usableMvIds.length) {
      continue;
    }
    const mvId = rand(usableMvIds);
    usableMvIds = without(usableMvIds, mvId);
    const start = rand([dayjs(faker.date.recent({ days: 3 })), dayjs()]);

    const row = [
      step, // id
      mvId, // modelVersionId
      start.startOf('day').format(), // validFrom
      start.add(1, 'day').format(), // validTo
      faker.number.int({ min: 1, max: 40 }), // position
    ];

    ret.push(row);
  }

  return ret;
};

/**
 * Changelog
 */
const genChangelogs = (num: number) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 1 }).toISOString();

    const row = [
      step, // id
      faker.lorem.sentence({ min: 2, max: 30 }), // title
      `<p>${faker.lorem.paragraph({ min: 1, max: 50 })}</p>`, // content // TODO make this more html-y
      randw([
        { value: null, weight: 2 },
        { value: `https://civitai.com/${faker.lorem.slug(5)}`, weight: 1 },
      ]), // link
      randw([
        { value: null, weight: 3 },
        { value: `https://civitai.com/${faker.lorem.slug(5)}`, weight: 1 },
      ]), // cta
      faker.date.past({ years: 1 }).toISOString(), // effectiveAt
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      rand(Object.values(ChangelogType)), // type
      rand(['{}', `{${faker.lorem.words({ min: 1, max: 10 }).split(' ').join(',')}}`]), // tags
      randw([
        { value: false, weight: 15 },
        { value: true, weight: 1 },
      ]), // disabled
      rand(['blue', 'purple', 'red', 'orange', 'yellow', 'green', 'junk', null]), // titleColor
      randw([
        { value: false, weight: 15 },
        { value: true, weight: 1 },
      ]), // sticky
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * Chat
 */
const genChats = (num: number, userIds: number[]) => {
  const ret = [] as [number, string, string, number][];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.past({ years: 3 }).toISOString();
    const owner = rand(userIds);
    const otherUsers = without(userIds, owner);
    const members = [
      owner,
      rand(otherUsers),
      randw([
        { value: rand(otherUsers), weight: 1 },
        { value: null, weight: 15 },
      ]),
    ].filter(isDefined);

    const row = [
      step, // id
      created, // createdAt
      getChatHash(members), // hash
      owner, // ownerId
    ] satisfies [number, string, string, number];

    ret.push(row);
  }
  return ret;
};

/**
 * ChatMember
 */
const genChatMembers = (chatData: { chatId: number; userIds: number[]; createdAt: string }[]) => {
  const ret = [];

  let i = 1;
  for (const { chatId, userIds, createdAt } of chatData) {
    let isOwner = true;
    for (const userId of userIds) {
      const status = !isOwner
        ? randw([
            { value: ChatMemberStatus.Joined, weight: 10 },
            { value: ChatMemberStatus.Invited, weight: 6 },
            {
              value: rand(
                Object.values(ChatMemberStatus).filter(
                  (s) => s !== ChatMemberStatus.Joined && s !== ChatMemberStatus.Invited
                )
              ),
              weight: 1,
            },
          ])
        : ChatMemberStatus.Joined;

      const row = [
        i, // id
        createdAt, // createdAt
        userId, // userId
        chatId, // chatId
        isOwner, // isOwner
        !isOwner ? fbool(0.02) : false, // isMuted
        status, // status
        null, // lastViewedMessageId
        status === ChatMemberStatus.Joined
          ? faker.date.between({ from: createdAt, to: Date.now() }).toISOString()
          : null, // joinedAt
        status === ChatMemberStatus.Left
          ? faker.date.between({ from: createdAt, to: Date.now() }).toISOString()
          : null, // leftAt
        status === ChatMemberStatus.Kicked
          ? faker.date.between({ from: createdAt, to: Date.now() }).toISOString()
          : null, // kickedAt
        null, // unkickedAt
        status === ChatMemberStatus.Ignored
          ? faker.date.between({ from: createdAt, to: Date.now() }).toISOString()
          : null, // ignoredAt
      ];
      ret.push(row);

      i++;
      isOwner = false;
    }
  }

  return ret;
};

/**
 * ChatMessage
 */
const genChatMessages = (chatData: { chatId: number; userIds: number[]; createdAt: string }[]) => {
  const ret = [];

  let i = 1;
  for (const { chatId, userIds, createdAt } of chatData) {
    for (
      let step = 0;
      step <=
      randw([
        { value: 0, weight: 1 },
        { value: faker.number.int({ min: 1, max: 20 }), weight: 10 },
      ]);
      step++
    ) {
      const row = [
        i, // id
        faker.date.between({ from: createdAt, to: Date.now() }).toISOString(), // createdAt
        rand(userIds), // userId
        chatId, // chatId
        randPrependBad(faker.lorem.sentence({ min: 1, max: 20 })), // content
        ChatMessageType.Markdown, // contentType // TODO include embeds
        null, // referenceMessageId
        null, // editedAt
      ];
      ret.push(row);

      i++;
    }
  }

  return ret;
};

/**
 * Bounty
 */
const genBounties = (num: number, userIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const created = faker.date.recent({ days: 30 }).toISOString();
    const startsAt = dayjs(created).add(faker.number.int({ min: 0, max: 10 }), 'day');
    const expiresAt = startsAt.add(faker.number.int({ min: 1, max: 30 }), 'day');

    const row = [
      step, // id
      rand(userIds), // userId
      randPrependBad(generateRandomName(faker.number.int({ min: 1, max: 6 }))), // name
      `<p>${randPrependBad(faker.lorem.paragraph({ min: 1, max: 8 }))}</p>`, // description
      startsAt.format('YYYY-MM-DD'), // startsAt
      expiresAt.format('YYYY-MM-DD'), // expiresAt
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      rand([null, `{"baseModel": "${rand(baseModels)}"}`]), // details
      rand(Object.values(BountyMode)), // mode
      rand(Object.values(BountyEntryMode)), // entryMode
      rand(Object.values(BountyType)), // type
      500, // minBenefactorUnitAmount
      null, // maxBenefactorUnitAmount
      faker.number.int({ min: 1, max: 999 }), // entryLimit
      fbool(), // nsfw
      expiresAt < dayjs(), // complete
      fbool(0.1), // poi
      fbool(0.2), // refunded
      randw([
        { value: 'Public', weight: 30 },
        {
          value: rand(Object.values(Availability).filter((v) => !['Public'].includes(v))),
          weight: 1,
        },
      ]), // availability
      randw([
        { value: 0, weight: 1 },
        { value: 1, weight: 4 },
        { value: 28, weight: 3 },
        { value: 15, weight: 2 },
        { value: 31, weight: 2 },
      ]), // nsfwLevel
      '{}', // lockedProperties
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * BountyEntry
 */
const genBountyEntries = (
  num: number,
  userIds: number[],
  bountyData: { id: number; createdAt: string }[]
) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const bounty = rand(bountyData);
    const created = faker.date.between({ from: bounty.createdAt, to: Date.now() }).toISOString();

    const row = [
      step, // id
      rand(userIds), // userId
      bounty.id, // bountyId
      created, // createdAt
      rand([created, faker.date.between({ from: created, to: Date.now() }).toISOString()]), // updatedAt
      fbool(0.01), // locked
      rand([null, `<p>${randPrependBad(faker.lorem.paragraph({ min: 1, max: 8 }))}</p>`]), // description
      randw([
        { value: 0, weight: 1 },
        { value: 1, weight: 4 },
        { value: 28, weight: 3 },
        { value: 15, weight: 2 },
        { value: 31, weight: 2 },
      ]), // nsfwLevel
    ];

    ret.push(row);
  }
  return ret;
};

const genBountyImageConnections = (
  bountyIds: number[],
  bountyEntryIds: number[],
  imageIds: number[]
) => {
  const ret = [];
  const remainingImageIds = [...imageIds];

  for (const bountyId of bountyIds) {
    for (let step = 1; step <= faker.number.int({ min: 0, max: 2 }); step++) {
      if (remainingImageIds.length === 0) break;

      const imageId = rand(remainingImageIds);
      const index = remainingImageIds.indexOf(imageId);
      if (index !== -1) remainingImageIds.splice(index, 1);

      const row = [
        imageId, // imageId
        bountyId, // entityId
        'Bounty', // entityType
      ];
      ret.push(row);
    }
  }

  for (const bountyEntryId of bountyEntryIds) {
    for (let step = 1; step <= faker.number.int({ min: 0, max: 3 }); step++) {
      if (remainingImageIds.length === 0) break;

      const imageId = rand(remainingImageIds);
      const index = remainingImageIds.indexOf(imageId);
      if (index !== -1) remainingImageIds.splice(index, 1);

      const row = [
        imageId, // imageId
        bountyEntryId, // entityId
        'BountyEntry', // entityType
      ];
      ret.push(row);
    }
  }

  return ret;
};

// ---
// Data end
// ---

const genRows = async (truncate = true) => {
  if (truncate) await truncateRows();

  const users = genUsers(numRows, true);
  const userIds = await insertRows('User', users);

  const models = genModels(numRows, userIds);
  const modelIds = await insertRows('Model', models);
  const modelData = models
    .map((m) => ({
      id: m[6] as number,
      userId: m[7] as number,
      uploadType: m[25] as ModelUploadType,
      type: m[2] as ModelType,
      status: m[9] as ModelStatus,
      availability: m[28] as Availability,
    }))
    .filter((m) => modelIds.includes(m.id));

  const mvs = genMvs(Math.ceil(numRows * 3), modelData);
  const mvIds = await insertRows('ModelVersion', mvs);
  const mvData = mvs
    .map((mv) => {
      const modelId = mv[7] as number;
      const matchModel = modelData.find((m) => m.id === modelId);
      return {
        id: mv[6] as number,
        modelId: modelId,
        userId: matchModel?.userId,
        uploadType: mv[28] as ModelUploadType,
        type: matchModel?.type,
        status: matchModel?.status,
        availability: matchModel?.availability,
        baseModelType: mv[19] as BaseModelType, // scannedAt
      };
    })
    .filter((mv) => mvIds.includes(mv.id));

  const mFiles = genMFiles(mvData);
  await insertRows('ModelFile', mFiles);

  const coveredCheckpoints = genCoveredCheckpoints(
    Math.ceil(numRows / 2),
    mvData.filter(
      (mv) =>
        mv.type === 'Checkpoint' &&
        mv.status === 'Published' &&
        mv.availability === 'Public' &&
        mv.baseModelType === 'Standard'
    )
  );
  await insertRows('CoveredCheckpoint', coveredCheckpoints, false);

  const reviews = genReviews(Math.ceil(numRows * 5), userIds, mvData);
  const reviewIds = await insertRows('ResourceReview', reviews);

  const posts = genPosts(Math.ceil(numRows * 4), userIds, mvData);
  const postIds = await insertRows('Post', posts);

  const images = genImages(Math.ceil(numRows * 8), userIds, postIds);
  const imageIds = await insertRows('Image', images);

  const userProfiles = genUserProfiles(userIds, imageIds);
  await insertRows('UserProfile', userProfiles, false);

  const articles = genArticles(numRows, userIds, imageIds);
  const articleIds = await insertRows('Article', articles);

  const tools = genTools(10);
  const toolIds = await insertRows('Tool', tools);

  const techniques = genTechniques();
  const techniqueIds = await insertRows('Technique', techniques);

  const collections = genCollections(numRows, userIds, imageIds);
  const collectionIds = await insertRows('Collection', collections);
  const collectionData = collections
    .map((c) => ({
      id: c[0] as number,
      type: c[8] as CollectionType,
    }))
    .filter((c) => collectionIds.includes(c.id));

  const collectionItems = genCollectionItems(
    Math.ceil(numRows * 2),
    collectionData,
    articleIds,
    postIds,
    imageIds,
    modelIds,
    userIds
  );
  await insertRows('CollectionItem', collectionItems);

  const imageTools = genImageTools(numRows, imageIds, toolIds);
  await insertRows('ImageTool', imageTools, false);

  const imageTechniques = genImageTechniques(numRows, imageIds, techniqueIds);
  await insertRows('ImageTechnique', imageTechniques, false);

  const tags = genTags(numRows);
  const tagIds = await insertRows('Tag', tags);

  const tagsOnTags = genTagsOnTags(
    20,
    tags.filter((t) => t[7] === true).map((t) => t[4] as number)
  );
  await insertRows('TagsOnTags', tagsOnTags, false);

  const tagsOnArticles = genTagsOnArticles(Math.ceil(numRows * 3), tagIds, articleIds);
  await insertRows('TagsOnArticle', tagsOnArticles, false);

  const tagsOnPosts = genTagsOnPosts(Math.ceil(numRows * 3), tagIds, postIds);
  await insertRows('TagsOnPost', tagsOnPosts, false);

  const tagsOnImages = genTagsOnImages(Math.ceil(numRows * 3), tagIds, imageIds);
  await insertRows('TagsOnImageNew', tagsOnImages, false);

  const tagsOnModels = genTagsOnModels(Math.ceil(numRows * 3), tagIds, modelIds);
  await insertRows('TagsOnModels', tagsOnModels, false);

  // TODO TagsOnImageVote
  // TODO TagsOnModelsVote

  const commentsV1 = genCommentsModel(Math.ceil(numRows * 3), userIds, modelIds, [], false);
  const commentsV1Ids = await insertRows('Comment', commentsV1);

  const commentsV1Thread = genCommentsModel(
    numRows,
    userIds,
    modelIds,
    commentsV1Ids,
    true,
    commentsV1Ids[commentsV1Ids.length - 1]
  );
  const commentsV1AllIds = await insertRows('Comment', commentsV1Thread);

  const threads = genThreads(
    Math.ceil(numRows * 3),
    imageIds,
    postIds,
    reviewIds,
    articleIds,
    [],
    [],
    false
  );
  const threadIds = await insertRows('Thread', threads);

  const commentsV2 = genCommentsV2(Math.ceil(numRows * 4), userIds, threadIds);
  const commentsV2Ids = await insertRows('CommentV2', commentsV2);

  const threadsNest = genThreads(
    numRows,
    [],
    [],
    [],
    [],
    commentsV2Ids,
    commentsV2.map((c) => c[7] as number),
    true,
    threadIds[threadIds.length - 1]
  );
  const threadsNestIds = await insertRows('Thread', threadsNest);

  const commentsV2Nest = genCommentsV2(
    numRows,
    userIds,
    threadsNestIds,
    commentsV2Ids[commentsV2Ids.length - 1]
  );
  const commentsV2NestIds = await insertRows('CommentV2', commentsV2Nest);

  const commentsV2AllIds = commentsV2Ids.concat(commentsV2NestIds);

  const resources = genImageResources(numRows, mvIds, imageIds);
  await insertRows('ImageResource', resources);

  const articleEngage = genArticleEngagements(numRows, userIds, articleIds);
  await insertRows('ArticleEngagement', articleEngage, false);
  const imageEngage = genImageEngagements(numRows, userIds, imageIds);
  await insertRows('ImageEngagement', imageEngage, false);
  const modelEngage = genModelEngagements(numRows, userIds, modelIds);
  await insertRows('ModelEngagement', modelEngage, false);
  const mvEngage = genModelVersionEngagements(numRows, userIds, mvIds);
  await insertRows('ModelVersionEngagement', mvEngage, false);
  const tagEngage = genTagEngagements(numRows, userIds, tagIds);
  await insertRows('TagEngagement', tagEngage, false);
  const userEngage = genUserEngagements(numRows, userIds, userIds);
  await insertRows('UserEngagement', userEngage, false);

  const articleReactions = genArticleReactions(Math.ceil(numRows * 5), userIds, articleIds);
  await insertRows('ArticleReaction', articleReactions);
  const commentV1Reactions = genCommentReactions(Math.ceil(numRows * 5), userIds, commentsV1AllIds);
  await insertRows('CommentReaction', commentV1Reactions);
  const commentV2Reactions = genCommentV2Reactions(
    Math.ceil(numRows * 5),
    userIds,
    commentsV2AllIds
  );
  await insertRows('CommentV2Reaction', commentV2Reactions);
  const imageReactions = genImageReactions(Math.ceil(numRows * 5), userIds, imageIds);
  await insertRows('ImageReaction', imageReactions);
  const postReactions = genPostReactions(Math.ceil(numRows * 5), userIds, postIds);
  await insertRows('PostReaction', postReactions);

  const leaderboards = genLeaderboards();
  await insertRows('Leaderboard', leaderboards, false);

  const homeblocks = genHomeBlocks(collectionData);
  await insertRows('HomeBlock', homeblocks);

  const auctionBases = genAuctionBases();
  const auctionBaseIds = await insertRows('AuctionBase', auctionBases);

  const auctions = genAuctions(auctionBaseIds);
  await insertRows('Auction', auctions);
  // get all auctions except the last one (future date)
  const filteredAuctionIds = auctions
    .filter((_, index) => (index + 1) % 3 !== 0)
    .map((a) => a[0] as number);

  const bids = genBids(numRows, filteredAuctionIds, userIds, modelIds);
  await insertRows('Bid', bids);

  const bidRecurrings = genBidRecurrings(
    Math.round(numRows / 4),
    auctionBaseIds,
    userIds,
    modelIds
  );
  await insertRows('BidRecurring', bidRecurrings);

  const featuredModelVersions = genFeaturedModelVersions(auctions.length * 10, mvIds);
  await insertRows('FeaturedModelVersion', featuredModelVersions);

  const changelogs = genChangelogs(Math.round(numRows / 4));
  await insertRows('Changelog', changelogs);

  const chats = genChats(
    numRows,
    userIds.filter((u) => u > 0)
  );
  const chatIds = await insertRows('Chat', chats);
  const chatData = chats
    .map((c) => ({
      chatId: c[0],
      userIds: getUsersFromHash(c[2]),
      createdAt: c[1],
    }))
    .filter((c) => chatIds.includes(c.chatId));

  const chatMembers = genChatMembers(chatData);
  await insertRows('ChatMember', chatMembers);

  const chatMessages = genChatMessages(chatData);
  await insertRows('ChatMessage', chatMessages);

  const bounties = genBounties(numRows, userIds);
  const bountyIds = await insertRows('Bounty', bounties);

  const bountyEntries = genBountyEntries(
    numRows * 4,
    userIds,
    bounties
      .map((b) => ({ id: b[0] as number, createdAt: b[6] as string }))
      .filter((b) => bountyIds.includes(b.id))
  );
  const bountyEntryIds = await insertRows('BountyEntry', bountyEntries);

  const imageConnections = genBountyImageConnections(bountyIds, bountyEntryIds, imageIds);
  await insertRows('ImageConnection', imageConnections, false);

  if (truncQueue) {
    await deleteRandomJobQueueRows(98, 'pct');
    // await deleteRandomJobQueueRows(200, 'count');
  }
};

/**
 * Notification
 */
const genNotifications = (num: number) => {
  const ret = [];

  const types = Object.keys(notificationProcessors);

  for (let step = 1; step <= num; step++) {
    const row = [
      step, // id
      rand(types), // type
      faker.string.uuid(), // key // TODO this isn't right, but it works
      rand(Object.values(NotificationCategory)), // category
      '{}', // details // TODO
    ];

    ret.push(row);
  }
  return ret;
};

/**
 * UserNotification
 */
const genUserNotifications = (num: number, notifIds: number[], userIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const row = [
      step, // id
      rand(notifIds), // notificationId
      rand(userIds), // userId
      fbool(), // viewed
      faker.date.past({ years: 3 }).toISOString(), // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

const genNotificationRows = async (truncate = true) => {
  if (truncate) await truncateNotificationRows();

  const userData = await pgDbWrite.query<{ id: number }>(`SELECT id from "User"`);
  const userIds = userData.rows.map((u) => u.id);

  const notifs = genNotifications(numRows);
  const notifIds = await insertNotifRows('Notification', notifs);

  const userNotifs = genUserNotifications(numRows * 3, notifIds, userIds);
  await insertNotifRows('UserNotification', userNotifs);
};

/**
 * entityMetricEvents
 */
const genEntityMetricEvents = (num: number, imageIds: number[], userIds: number[]) => {
  const ret = [];

  for (let step = 1; step <= num; step++) {
    const reaction = rand(Object.values(EntityMetric_MetricType_Type));
    const row = [
      'Image', // entityType
      rand(imageIds), // entityId
      rand(userIds), // userId
      reaction, // metricType,
      reaction === 'Buzz' ? faker.number.int(5000) : rand([1, -1]), // metricValue
      faker.date.past({ years: 3 }).toISOString(), // createdAt
    ];

    ret.push(row);
  }
  return ret;
};

const genClickhouseRows = async () => {
  if (!clickhouse) {
    console.log(`No clickhouse client. Skipping.`);
    return;
  }

  const imageData = await pgDbWrite.query<{ id: number }>(`SELECT id from "Image"`);
  const imageIds = imageData.rows.map((i) => i.id);
  const userData = await pgDbWrite.query<{ id: number }>(`SELECT id from "User"`);
  const userIds = userData.rows.map((u) => u.id);

  const entityMetricEvents = genEntityMetricEvents(numRows * 10, imageIds, userIds);
  await insertClickhouseRows('entityMetricEvents', entityMetricEvents);
};

const genRedisSystemFeatures = async () => {
  console.log(`Inserting system data into redis`);

  // Generation status
  await sysRedis.hSet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    REDIS_SYS_KEYS.GENERATION.STATUS,
    JSON.stringify({
      available: true,
      message: null,
      charge: true,
      checkResourceAvailability: true,
      limits: {
        free: {
          steps: 50,
          quantity: 4,
          queue: 4,
          resources: 9,
        },
        founder: {
          quantity: 10,
          queue: 10,
          steps: 60,
          resources: 12,
        },
      },
      membershipPriority: false,
    })
  );

  // Training status
  await sysRedis.hSet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    REDIS_SYS_KEYS.TRAINING.STATUS,
    JSON.stringify({
      available: true,
      message: null,
      blockedModels: [],
    })
  );

  // Generation workflows
  await sysRedis.hSet(
    REDIS_SYS_KEYS.GENERATION.WORKFLOWS,
    'txt2img',
    JSON.stringify({
      type: 'txt2img',
      key: 'txt2img',
      name: '',
      features: ['draft'],
      template:
        '{"3": { "inputs": { "seed": {{seed}}, "steps": {{steps}}, "cfg": {{cfgScale}}, "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": 1.0, "model": [ "4", 0 ], "positive": [ "6", 0 ], "negative": [ "7", 0 ], "latent_image": [ "5", 0 ]}, "class_type": "KSampler" }, "4": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple" }, "5": { "inputs": { "width": {{width}}, "height": {{height}}, "batch_size": 1 }, "class_type": "EmptyLatentImage" }, "6": { "inputs": { "parser": "A1111", "mean_normalization": true, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 6.0, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "text": "{{prompt}}", "clip": [ "10", 0 ]}, "class_type": "smZ CLIPTextEncode" }, "7": { "inputs": { "parser": "A1111", "mean_normalization": true, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "text": "{{negativePrompt}}", "clip": [ "10", 0 ]}, "class_type": "smZ CLIPTextEncode" }, "8": { "inputs": { "samples": [ "3", 0 ], "vae": [ "4", 2 ]}, "class_type": "VAEDecode" }, "9": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "8", 0 ]}, "class_type": "SaveImage" }, "10": { "inputs": { "stop_at_clip_layer": 0, "clip": [ "4", 1 ]}, "class_type": "CLIPSetLastLayer" }}',
    })
  );
  await sysRedis.hSet(
    REDIS_SYS_KEYS.GENERATION.WORKFLOWS,
    'txt2img-hires',
    JSON.stringify({
      type: 'txt2img',
      key: 'txt2img-hires',
      name: 'Hi-res fix',
      description: 'Generate an image then upscale it and regenerate it',
      features: ['denoise', 'upscale'],
      template:
        '{"6":{"inputs":{"text":"{{prompt}}","parser":"A1111","mean_normalization":true,"multi_conditioning":true,"use_old_emphasis_implementation":false,"with_SDXL":false,"ascore":2.5,"width":0,"height":0,"crop_w":0,"crop_h":0,"target_width":0,"target_height":0,"text_g":"","text_l":"","smZ_steps":1,"clip":["101",1]},"class_type":"smZ CLIPTextEncode","_meta":{"title":"Positive"}},"7":{"inputs":{"text":"{{negativePrompt}}","parser":"A1111","mean_normalization":true,"multi_conditioning":true,"use_old_emphasis_implementation":false,"with_SDXL":false,"ascore":2.5,"width":0,"height":0,"crop_w":0,"crop_h":0,"target_width":0,"target_height":0,"text_g":"","text_l":"","smZ_steps":1,"clip":["101",1]},"class_type":"smZ CLIPTextEncode","_meta":{"title":"Negative"}},"11":{"inputs":{"seed":"{{{seed}}}","steps":"{{{steps}}}","cfg":"{{{cfgScale}}}","sampler_name":"{{sampler}}","scheduler":"{{scheduler}}","denoise":1,"model":["101",0],"positive":["6",0],"negative":["7",0],"latent_image":["26",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},"12":{"inputs":{"filename_prefix":"ComfyUI","images":["25",0]},"class_type":"SaveImage","_meta":{"title":"Save Image"}},"19":{"inputs":{"upscale_model":["20",0],"image":["27",0]},"class_type":"ImageUpscaleWithModel","_meta":{"title":"Upscale Image (using Model)"}},"20":{"inputs":{"model_name":"urn:air:other:upscaler:civitai:147759@164821"},"class_type":"UpscaleModelLoader","_meta":{"title":"Load Upscale Model"}},"21":{"inputs":{"pixels":["23",0],"vae":["101",2]},"class_type":"VAEEncode","_meta":{"title":"VAE Encode"}},"23":{"inputs":{"upscale_method":"nearest-exact","width":"{{{upscaleWidth}}}","height":"{{{upscaleHeight}}}","crop":"disabled","image":["19",0]},"class_type":"ImageScale","_meta":{"title":"Upscale Image"}},"24":{"inputs":{"seed":"{{{seed}}}","steps":"{{{steps}}}","cfg":"{{{cfgScale}}}","sampler_name":"{{sampler}}","scheduler":"{{scheduler}}","denoise":"{{{denoise}}}","model":["101",0],"positive":["6",0],"negative":["7",0],"latent_image":["21",0]},"class_type":"KSampler","_meta":{"title":"KSampler"}},"25":{"inputs":{"samples":["24",0],"vae":["101",2]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},"26":{"inputs":{"width":"{{{width}}}","height":"{{{height}}}","batch_size":1},"class_type":"EmptyLatentImage","_meta":{"title":"Empty Latent Image"}},"27":{"inputs":{"samples":["11",0],"vae":["101",2]},"class_type":"VAEDecode","_meta":{"title":"VAE Decode"}},"28":{"inputs":{"filename_prefix":"ComfyUI","images":["27",0]},"class_type":"SaveImage","_meta":{"title":"Save Image"}},"101":{"inputs":{"ckpt_name":"placeholder.safetensors"},"class_type":"CheckpointLoaderSimple","_meta":{"title":"Load Checkpoint"}}}',
    })
  );
  await sysRedis.hSet(
    REDIS_SYS_KEYS.GENERATION.WORKFLOWS,
    'img2img',
    JSON.stringify({
      type: 'img2img',
      key: 'img2img',
      name: 'Variations (img2img)',
      description: 'Generate a similar image',
      features: ['denoise', 'image'],
      template:
        '{ "6": { "inputs": { "text": "{{prompt}}", "parser": "A1111", "mean_normalization": true, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "smZ_steps": 1, "clip": [ "101", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "Positive" } }, "7": { "inputs": { "text": "{{negativePrompt}}", "parser": "A1111", "mean_normalization": true, "multi_conditioning": true, "use_old_emphasis_implementation": false, "with_SDXL": false, "ascore": 2.5, "width": 0, "height": 0, "crop_w": 0, "crop_h": 0, "target_width": 0, "target_height": 0, "text_g": "", "text_l": "", "smZ_steps": 1, "clip": [ "101", 1 ] }, "class_type": "smZ CLIPTextEncode", "_meta": { "title": "Negative" } }, "11": { "inputs": { "seed": "{{{seed}}}", "steps": "{{{steps}}}", "cfg": "{{{cfgScale}}}", "sampler_name": "{{sampler}}", "scheduler": "{{scheduler}}", "denoise": "{{{denoise}}}", "model": [ "101", 0 ], "positive": [ "6", 0 ], "negative": [ "7", 0 ], "latent_image": [ "18", 0 ] }, "class_type": "KSampler", "_meta": { "title": "KSampler" } }, "12": { "inputs": { "filename_prefix": "ComfyUI", "images": [ "13", 0 ] }, "class_type": "SaveImage", "_meta": { "title": "Save Image" } }, "13": { "inputs": { "samples": [ "11", 0 ], "vae": [ "101", 2 ] }, "class_type": "VAEDecode", "_meta": { "title": "VAE Decode" } }, "17": { "inputs": { "image": "{{image}}", "upload": "image" }, "class_type": "LoadImage", "_meta": { "title": "Image Load" } }, "18": { "inputs": { "pixels": [ "17", 0 ], "vae": [ "101", 2 ] }, "class_type": "VAEEncode", "_meta": { "title": "VAE Encode" } }, "101": { "inputs": { "ckpt_name": "placeholder.safetensors" }, "class_type": "CheckpointLoaderSimple", "_meta": { "title": "Load Checkpoint" } } }',
    })
  );

  // Generation engines
  await sysRedis.hSet(
    REDIS_SYS_KEYS.GENERATION.ENGINES,
    'hunyuan',
    JSON.stringify({
      engine: 'hunyuan',
      disabled: false,
      message: '',
      status: 'published',
    })
  );
  await sysRedis.hSet(
    REDIS_SYS_KEYS.GENERATION.ENGINES,
    'civitai',
    JSON.stringify({
      engine: 'civitai',
      disabled: true,
      status: 'disabled',
    })
  );

  // TODO fill these in
  await sysRedis.hSet(
    REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
    REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.CLAVATA_POLICIES,
    JSON.stringify({
      default: '6ac038b9-97e2-4ffb-84cb-be9e2ac93afd',
    })
  );
  await sysRedis.hSet(
    REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
    REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.ENTITIES,
    JSON.stringify({
      // Chat: true,
      // Comment: false,
      // CommentV2: true,
      // User: false,
      // UserProfile: false,
      // Model: false,
      // Post: false,
      ResourceReview: false,
      // Article: false,
      // Bounty: false,
      // BountyEntry: false,
      // Collection: false,
    })
  );
  await sysRedis.hSet(
    REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
    REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.RUN_WORDLISTS,
    JSON.stringify(false)
  );
  await sysRedis.hSet(
    REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
    REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.WORDLISTS,
    JSON.stringify(['illegal', 'hate', 'extremism'])
  );
  await sysRedis.hSet(
    REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
    REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.URLLISTS,
    JSON.stringify(['csam'])
  );

  await sysRedis.packed.hSet(REDIS_SYS_KEYS.ENTITY_MODERATION.WORDLISTS.WORDS, 'illegal', [
    'child',
  ]);
  await sysRedis.packed.hSet(REDIS_SYS_KEYS.ENTITY_MODERATION.WORDLISTS.WORDS, 'hate', ['hate']);
  await sysRedis.packed.hSet(REDIS_SYS_KEYS.ENTITY_MODERATION.WORDLISTS.WORDS, 'extremism', [
    'kill',
  ]);
  await sysRedis.packed.hSet(REDIS_SYS_KEYS.ENTITY_MODERATION.WORDLISTS.URLS, 'csam', ['kids.com']);

  console.log(`\t-> ✔️ Inserted redis data`);
};

const main = async () => {
  checkLocalDb();

  await pgDbWrite.query('REASSIGN OWNED BY doadmin, civitai, "civitai-jobs" TO postgres');
  await pgDbWrite.query(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "postgres"'
  );
  await pgDbWrite.query('GRANT ALL ON ALL TABLES IN schema public TO "postgres"');

  await genRows();

  await genNotificationRows();

  await genClickhouseRows();

  await genRedisSystemFeatures();
};

if (require.main === module) {
  main().then(() => {
    // pgDbRead.end();
    process.exit(0);
  });
}
