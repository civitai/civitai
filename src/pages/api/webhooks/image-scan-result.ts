import { Prisma } from '@prisma/client';
import { uniqBy } from 'lodash-es';
import { z } from 'zod';
import { env } from '~/env/server';
import { tagsNeedingReview as minorTags, tagsToIgnore } from '~/libs/tags';
import { clickhouse } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';
import {
  BlockedReason,
  NotificationCategory,
  NsfwLevel,
  SearchIndexUpdateQueueAction,
  SignalMessages,
} from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { getExplainSql } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { scanJobsSchema } from '~/server/schema/image.schema';
import { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import { addImageToQueue } from '~/server/services/games/new-order.service';
import {
  getImagesModRules,
  getTagNamesForImages,
  queueImageSearchIndexUpdate,
} from '~/server/services/image.service';
import { createNotification } from '~/server/services/notification.service';
import { updatePostNsfwLevel } from '~/server/services/post.service';
import { getTagRules } from '~/server/services/system-cache';
import {
  insertTagsOnImageNew,
  upsertTagsOnImageNew,
} from '~/server/services/tagsOnImageNew.service';
import { deleteUserProfilePictureCache } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { evaluateRules } from '~/server/utils/mod-rules';
import { getComputedTags } from '~/server/utils/tag-rules';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import {
  ImageIngestionStatus,
  ModerationRuleAction,
  NewOrderRankType,
  TagSource,
  TagTarget,
  TagType,
} from '~/shared/utils/prisma/enums';
import { isValidAIGeneration } from '~/utils/image-utils';
import {
  auditMetaData,
  getTagsFromPrompt,
  includesInappropriate,
  includesPoi,
} from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/normalize-text';
import { signalClient } from '~/utils/signal-client';
import { isDefined } from '~/utils/type-guards';

const REQUIRED_SCANS = 2;

const localTagCache: Record<string, { id: number; blocked?: true; ignored?: true }> = {};

enum Status {
  Success = 0,
  NotFound = 1, // image not found at url
  Unscannable = 2,
}

const pendingStates: ImageIngestionStatus[] = [
  ImageIngestionStatus.Pending,
  ImageIngestionStatus.Error,
];

type IncomingTag = z.infer<typeof tagSchema>;
const tagSchema = z.object({
  tag: z.string().transform((x) => x.toLowerCase().trim()),
  id: z.number().optional(),
  confidence: z.number(),
});
type BodyProps = z.infer<typeof schema>;
const schema = z.object({
  id: z.number(),
  isValid: z.boolean(),
  tags: tagSchema.array().nullish(),
  hash: z.string().nullish(),
  vectors: z.array(z.number().array()).nullish(),
  status: z.nativeEnum(Status),
  source: z.nativeEnum(TagSource),
  context: z
    .object({
      movie_rating: z.string().optional(),
      movie_rating_model_id: z.string().optional(),
      hasMinor: z.boolean().optional(),
    })
    .nullish(),
  result: z
    .object({
      age: z.number(),
      tags: tagSchema.array(),
      dimensions: z.object({
        top: z.number(),
        bottom: z.number(),
        left: z.number(),
        right: z.number(),
      }),
    })
    .array()
    .nullish(),
});

function shouldIgnore(tag: string, source: TagSource) {
  return tagsToIgnore[source]?.includes(tag) ?? false;
}

export default WebhookEndpoint(async function imageTags(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const bodyResults = schema.safeParse(req.body);
  if (!bodyResults.success)
    return res.status(400).json({
      ok: false,
      error: bodyResults.error,
    });

  const data = bodyResults.data;

  try {
    switch (bodyResults.data.status) {
      case Status.NotFound:
        await dbWrite.image.updateMany({
          where: { id: data.id, ingestion: { in: pendingStates } },
          data: { ingestion: ImageIngestionStatus.NotFound },
        });
        break;
      case Status.Unscannable:
        const image = await dbWrite.image.findUnique({
          where: { id: data.id },
          select: { scanJobs: true },
        });

        const scanJobs = scanJobsSchema.parse(image?.scanJobs ?? {});
        scanJobs.retryCount = scanJobs.retryCount ?? 0;
        scanJobs.retryCount++;

        await dbWrite.image.updateMany({
          where: { id: data.id, ingestion: { in: pendingStates } },
          data: {
            ingestion: ImageIngestionStatus.Error,
            scanJobs: scanJobs as any,
          },
        });
        break;
      case Status.Success:
        await handleSuccess(data);
        break;
      default: {
        await logScanResultError({ id: data.id, message: 'unhandled data type' });
        throw new Error('unhandled data type');
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    if (e.message === 'Image not found') return res.status(404).send({ error: e.message });
    return res.status(400).send({ error: e.message });
  }
});

type Tag = { tag: string; confidence: number; id?: number; source?: TagSource };

// @see https://stackoverflow.com/questions/14925151/hamming-distance-optimization-for-mysql-or-postgresql
// 1-10:  The images are visually almost identical
// 11-20: The images are visually similar
// 21-30: The images are visually somewhat similar
async function isBlocked(hash: string) {
  if (!env.BLOCKED_IMAGE_HASH_CHECK || !clickhouse) return false;

  const [{ count }] = await clickhouse.$query<{ count: number }>`
    SELECT cast(count() as int) as count
    FROM blocked_images
    WHERE bitCount(bitXor(hash, ${hash})) < 5
  `;

  return count > 0;
}

async function handleSuccess({
  id,
  tags: incomingTags = [],
  source,
  context,
  hash,
  result,
}: BodyProps) {
  // this is a temporary solution to add all clavata tags to the table `ShadowTagsOnImage`
  if (source === TagSource.Clavata && env.CLAVATA_SCAN === 'shadow') {
    const response = await getTagsFromIncomingTags({
      id,
      tags: incomingTags,
      source,
    });
    if (!response) return;
    const { tags } = response;
    const data = tags
      .map((x) => (!!x.id ? { tagId: x.id, imageId: id, confidence: x.confidence } : null))
      .filter(isDefined);
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "ShadowTagsOnImage" ("tagId", "imageId", "confidence")
      VALUES ${data.map((x) => `(${x.tagId}, ${x.imageId}, ${x.confidence})`).join(',')}
      ON CONFLICT ("tagId", "imageId") DO UPDATE
        SET "confidence" = EXCLUDED."confidence"
    `);
    return;
  }

  if (hash && (await isBlocked(hash))) {
    await dbWrite.image.update({
      where: { id },
      data: {
        pHash: BigInt(hash),
        ingestion: ImageIngestionStatus.Blocked,
        nsfwLevel: NsfwLevel.Blocked,
        blockedFor: 'Similar to blocked content',
      },
    });
    return;
  }

  if (hash && source === TagSource.ImageHash) {
    await dbWrite.image.update({
      where: { id },
      data: { pHash: BigInt(hash), updatedAt: new Date() },
    });
    return;
  }

  if (source === TagSource.HiveDemographics || source === TagSource.MinorDetection) {
    const update: Record<string, any> = {
      [source]: Date.now(),
    };
    const additionalUpdates: string[] = [];
    let hasMinor = false;

    // Process hive demographics
    if (source === TagSource.HiveDemographics) {
      if (!result) return;

      const age = Math.min(...result.map((x) => x.age));
      if (age < 18) hasMinor = true;
      update.age = Math.round(age);
      update.demographics = result.map((x) => {
        const demographic: Record<string, any> = {
          age: Math.round(x.age),
          dimensions: x.dimensions,
        };

        for (const tag of x.tags) {
          if (['male', 'female'].includes(tag.tag)) {
            demographic.gender = tag.tag;
            break;
          }
        }

        return demographic;
      });
    } else hasMinor = context?.hasMinor ?? false;

    if (hasMinor) {
      update.hasMinor = true;
      additionalUpdates.push(
        `"needsReview" = CASE WHEN i."nsfwLevel" > ${NsfwLevel.PG} AND i."nsfwLevel" < ${NsfwLevel.Blocked} THEN 'minor' ELSE i."needsReview" END`
      );
    }

    await dbWrite.$executeRawUnsafe(`
      UPDATE "Image" i SET
        "scanJobs" = COALESCE("scanJobs", '{}') || '${JSON.stringify(update)}'::jsonb
        ${additionalUpdates.length ? `, ${additionalUpdates.join(', ')}` : ''}
      WHERE id = ${id};
    `);
    return;
  }

  const response = await getTagsFromIncomingTags({ id, source, tags: incomingTags });
  if (!response) return;
  const { image, tags, hasBlockedTag } = response;

  try {
    if (tags.length > 0) {
      const uniqTags = uniqBy(tags, (x) => x.id);
      const toInsert = uniqTags
        .filter((x) => x.id)
        .map((x) => ({
          imageId: id,
          tagId: x.id!,
          source: x.source ?? source,
          automated: true,
          confidence: x.confidence,
          disabled: shouldIgnore(x.tag, x.source ?? source),
        }));
      await insertTagsOnImageNew(toInsert);
    } else {
      await logToAxiom({
        type: 'image-scan-result',
        message: 'No tags found',
        imageId: id,
        source,
      });
    }

    const prompt = normalizeText(
      (image.meta as Prisma.JsonObject)?.['prompt'] as string | undefined
    );
    const negativePrompt = normalizeText(
      (image.meta as Prisma.JsonObject)?.['negativePrompt'] as string | undefined
    );

    // Mark image as scanned and set the nsfw field based on the presence of automated tags with type 'Moderation'
    const tagsFromTagsOnImageDetails = await dbWrite.$queryRaw<
      { name: string; nsfwLevel: number }[]
    >`
      SELECT t.name, t."nsfwLevel"
      FROM "TagsOnImageDetails" toi
      JOIN "Tag" t ON t.id = toi."tagId"
      WHERE toi."imageId" = ${id} AND toi.automated AND NOT toi.disabled
    `;

    let reviewKey: string | null = null;
    const flags = {
      hasAdultTag: false,
      hasMinorTag: false,
      hasCartoonTag: false,
      nsfw: false,
      minor: false,
      poi: false,
      minorReview: false,
      poiReview: false,
      tagReview: false,
      newUserReview: false,
    };

    // let hasAdultTag = false,
    //   hasMinorTag = false,
    //   hasCartoonTag = false,
    //   nsfw = false;
    for (const { name, nsfwLevel } of tagsFromTagsOnImageDetails) {
      if (nsfwLevel > sfwBrowsingLevelsFlag) flags.nsfw = true;
      if (minorTags.includes(name)) {
        flags.hasMinorTag = true;
        flags.minor = true;
      } else if (constants.imageTags.styles.includes(name)) flags.hasCartoonTag = true;
      else if (['adult'].includes(name)) flags.hasAdultTag = true;
    }

    const clavataNsfwLevel = tags.find((x) =>
      clavataNsfwLevelTags.includes(x.tag as ClavataNsfwLevelTag)
    )?.tag as ClavataNsfwLevelTag | undefined;
    if (clavataNsfwLevel) {
      switch (clavataNsfwLevel) {
        case 'pg':
          if (tags.some((x) => x.tag === 'child-10')) flags.minor = true;
          if (['realistic', 'child-15'].every((tag) => tags.find((x) => x.tag === tag))) {
            flags.minor = true;
            flags.minorReview = true;
          }
          break;
        case 'pg-13':
        case 'r':
        case 'x':
        case 'xxx':
          if (tags.some((x) => x.tag === 'child-10')) {
            flags.minor = true;
            flags.minorReview = true;
          }
          if (
            ['child-10', 'child-13', 'child-15'].some((tag) => tags.find((x) => x.tag === tag)) &&
            tags.some((x) => x.tag === 'realistic')
          ) {
            flags.minor = true;
            flags.minorReview = true;
          }
          break;
      }
    }

    const inappropriate = includesInappropriate({ prompt, negativePrompt }, flags.nsfw);
    if (inappropriate === 'minor') flags.minorReview = true;
    if (inappropriate === 'poi') flags.poiReview = true;
    if (prompt && includesPoi(prompt)) flags.poi = true;
    if (hasBlockedTag) flags.tagReview = true;

    const data: Prisma.ImageUpdateInput = {};

    // if (hasMinorTag) {
    //   data.minor = true;
    // }

    // const inappropriate = includesInappropriate({ prompt, negativePrompt }, flags.nsfw);
    // if (inappropriate !== false) reviewKey = inappropriate;
    // if (prompt && includesPoi(prompt)) data.poi = true; // We wanna mark it regardless of nsfw.
    // if (!reviewKey && hasBlockedTag) reviewKey = 'tag';

    // We now will mark images as poi / minor regardless of whether or not they're NSFW. This so that we know we need to hide from from
    // NSFW feeds.
    const [{ poi, minor, hasResource }] = await dbWrite.$queryRaw<
      { poi: boolean; minor: boolean; hasResource: boolean }[]
    >`
        WITH to_check AS (
          -- Check based on associated resources
          SELECT
            SUM(IIF(m.poi, 1, 0)) > 0 "poi",
            SUM(IIF(m.minor, 1, 0)) > 0 "minor",
            true "hasResource"
          FROM "ImageResourceNew" ir
          JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
          JOIN "Model" m ON m.id = mv."modelId"
          WHERE ir."imageId" = ${image.id}
          UNION
          -- Check based on associated bounties
          SELECT
            SUM(IIF(b.poi, 1, 0)) > 0 "poi",
            false "minor",
            false "hasResource"
          FROM "Image" i
          JOIN "ImageConnection" ic ON ic."imageId" = i.id
          JOIN "Bounty" b ON ic."entityType" = 'Bounty' AND b.id = ic."entityId"
          WHERE ic."imageId" = ${image.id}
          UNION
          -- Check based on associated bounty entries
          SELECT
            SUM(IIF(b.poi, 1, 0)) > 0 "poi",
            false "minor",
            false "hasResource"
          FROM "Image" i
          JOIN "ImageConnection" ic ON ic."imageId" = i.id
          JOIN "BountyEntry" be ON ic."entityType" = 'BountyEntry' AND be.id = ic."entityId"
          JOIN "Bounty" b ON b.id = be."bountyId"
          WHERE ic."imageId" = ${image.id}
        )
        SELECT bool_or(poi) "poi", bool_or(minor) "minor", bool_or("hasResource") "hasResource" FROM to_check;
      `;

    if (poi) {
      flags.poi = true;
      if (flags.nsfw) flags.poiReview = true;
    }

    if (minor) {
      flags.minor = true;
      if (flags.nsfw) flags.minorReview = true;
    }

    if (flags.hasMinorTag && !flags.hasAdultTag && (!flags.hasCartoonTag || flags.nsfw)) {
      flags.minorReview = true;
    }

    if (!flags.minorReview && !flags.poiReview && !flags.tagReview && flags.nsfw) {
      // If user is new and image is NSFW send it for review
      const [{ isNewUser }] =
        (await dbRead.$queryRaw<{ isNewUser: boolean }[]>`
        SELECT is_new_user(CAST(${image.userId} AS INT)) "isNewUser";
      `) ?? [];
      if (isNewUser) flags.newUserReview = true;
    }

    const reviewer = determineReviewer({ tags, source });
    if (reviewer === 'moderators') flags.tagReview = true;
    else if (reviewer === 'knights') {
      // TODO @manuelurenah - Add knight review logic
    }

    if (flags.poiReview) reviewKey = 'poi';
    else if (flags.minorReview) reviewKey = 'minor';
    else if (flags.tagReview) reviewKey = 'tag';
    else if (flags.newUserReview) reviewKey = 'newUser';

    if (flags.poi) data.poi = true;
    if (flags.minor) data.minor = true;
    if (reviewKey) data.needsReview = reviewKey;
    // Block NSFW images without meta:
    if (
      flags.nsfw &&
      !isValidAIGeneration({
        ...image,
        // Make it so that if we have NSFW tags we treat it as R+
        nsfwLevel: Math.max(image.nsfwLevel, flags.nsfw ? NsfwLevel.X : NsfwLevel.PG),
        meta: image.meta as ImageMetadata | VideoMetadata,
        tools: image.tools,
        // Avoids blocking images that we know are AI generated with some resources.
        resources: hasResource ? [1] : [],
      })
    ) {
      data.ingestion = ImageIngestionStatus.Blocked;
      data.blockedFor = BlockedReason.AiNotVerified;
    }

    if (flags.nsfw && prompt && data.ingestion !== ImageIngestionStatus.Blocked) {
      // Determine if we need to block the image
      const { success, blockedFor } = auditMetaData({ prompt }, flags.nsfw);
      if (!success) {
        data.ingestion = ImageIngestionStatus.Blocked;
        data.blockedFor = blockedFor?.join(',') ?? 'Failed audit, no explanation';
      }
    }

    if (Object.keys(data).length > 0) {
      data.updatedAt = new Date();
      await dbWrite.image.updateMany({
        where: { id },
        data,
      });
    }

    // Add to scanJobs and update aiRating
    let aiRating: NsfwLevel | undefined;
    let aiModel: string | undefined;
    if (source === TagSource.WD14 && !!context?.movie_rating) {
      aiRating = NsfwLevel[context.movie_rating as keyof typeof NsfwLevel];
      aiModel = context.movie_rating_model_id;
    }
    await dbWrite.$executeRawUnsafe(`
      UPDATE "Image" SET
        "scanJobs" = jsonb_set(COALESCE("scanJobs", '{}'), '{scans}', COALESCE("scanJobs"->'scans', '{}') || '{"${source}": ${Date.now()}}'::jsonb)
        ${aiRating ? `, "aiNsfwLevel" = ${aiRating}, "aiModel" = '${aiModel}'` : ''}
      WHERE id = ${id};
    `);

    // Update scannedAt and ingestion if not blocked
    if (data.ingestion !== 'Blocked') {
      const [{ ingestion } = { ingestion: ImageIngestionStatus.Pending }] = await dbWrite.$queryRaw<
        { ingestion: ImageIngestionStatus }[]
      >`
        WITH scan_count AS (
          SELECT id, COUNT(*) as count
          FROM "Image",
              jsonb_object_keys("scanJobs"->'scans') AS keys
          WHERE id = ${id}
          GROUP BY id
        )
        UPDATE "Image" i SET
          "scannedAt" =
            CASE
              WHEN i.metadata->'skipScannedAtReassignment' IS NOT NULL
                OR i."createdAt" < NOW() - INTERVAL '1 week'
              THEN "scannedAt"
              ELSE NOW()
            END,
          "updatedAt" = NOW(),
          "ingestion" ='Scanned'
        FROM scan_count s
        WHERE s.id = i.id AND s.count >= ${REQUIRED_SCANS}
        RETURNING "ingestion";
      `;
      data.ingestion = ingestion;

      if (ingestion === 'Scanned') {
        // Clear cached image tags after completing scans
        await tagIdsForImagesCache.refresh(id);
        const appliedRule = await applyModerationRules({
          ...image,
          prompt,
          metadata: image.metadata as ImageMetadata | VideoMetadata,
        });

        const imageMetadata = image.metadata as Prisma.JsonObject | undefined;
        const isProfilePicture = imageMetadata?.profilePicture === true;
        if (isProfilePicture) {
          await deleteUserProfilePictureCache(image.userId);
        }

        await dbWrite.$executeRaw`SELECT update_nsfw_level_new(${id}::int);`;
        if (image.postId) await updatePostNsfwLevel(image.postId);

        // Update search index
        const action =
          appliedRule?.action === ModerationRuleAction.Block
            ? SearchIndexUpdateQueueAction.Delete
            : SearchIndexUpdateQueueAction.Update;

        await queueImageSearchIndexUpdate({ ids: [id], action });

        // #region [NewOrder]
        // New Order Queue Management. Only added when scan is succesful.
        const queueDetails: { priority: 1 | 2 | 3; rankType: NewOrderRankType } = {
          priority: 1,
          rankType: NewOrderRankType.Knight,
        };

        if (flags.nsfw) queueDetails.priority = 2;

        if (reviewKey) {
          data.needsReview = reviewKey;
          queueDetails.rankType = NewOrderRankType.Templar;

          if (reviewKey === 'minor') queueDetails.priority = 1;
          if (reviewKey === 'poi') queueDetails.priority = 2;
        } else {
          // TODO.newOrder: Priority 1 for knights is not being used for the most part. We might wanna change that based off of tags or smt.
          await addImageToQueue({
            imageIds: id,
            rankType: queueDetails.rankType,
            priority: queueDetails.priority,
          });
        }
        // #endregion
      }
    }

    if (data.ingestion) {
      await signalClient.send({
        target: SignalMessages.ImageIngestionStatus,
        data: { imageId: image.id, ingestion: data.ingestion, blockedFor: data.blockedFor },
        userId: image.userId,
      });
    }
  } catch (e: any) {
    await logScanResultError({ id, message: e.message, error: e });
    throw new Error(e.message);
  }
}

async function logScanResultError({
  id,
  error,
  message,
}: {
  id: number;
  error?: any;
  message?: any;
}) {
  await logToAxiom({ name: 'image-scan-result', type: 'error', imageId: id, message, error });
}

// Tag Preprocessing
// --------------------------------------------------
const tagPreprocessors: Partial<Record<TagSource, (tags: IncomingTag[]) => IncomingTag[]>> = {
  [TagSource.WD14]: processWDTags,
  [TagSource.Hive]: processHiveTags,
  [TagSource.Clavata]: processClavataTags,
};

const clavataTagConfidenceRequirements: Record<string, number> = {
  daipers: 70,
  urine: 60,
  unconscious: 60,
  'graphic language': 70,
  'light violence': 70,
  hypnosis: 70,
  minimum: 51,
  minimumNsfw: 51,
};

type ClavataNsfwLevelTag = (typeof clavataNsfwLevelTags)[number];
const clavataNsfwLevelTags = ['pg', 'pg-13', 'r', 'x', 'xxx'] as const;

function processClavataTags(tags: IncomingTag[]) {
  // Map tags to lowercase
  tags = tags.map((tag) => ({
    ...tag,
    confidence: tag.confidence ?? 70,
    tag: tag.tag.toLowerCase(),
  }));

  // Filter out tags
  let highestNsfwTag: IncomingTag = { tag: 'pg', confidence: 100 };
  tags = tags.filter((tag) => {
    const nsfwLevelIndex = clavataNsfwLevelTags.indexOf(tag.tag as ClavataNsfwLevelTag);
    const isNsfwLevel = nsfwLevelIndex !== -1;

    // Remove tags below confidence threshold
    const minimumConfidence = isNsfwLevel
      ? clavataTagConfidenceRequirements.minimumNsfw
      : clavataTagConfidenceRequirements.minimum;
    const requiredConfidence = clavataTagConfidenceRequirements[tag.tag] ?? minimumConfidence;
    if (tag.confidence < requiredConfidence) return false;

    // Remove nsfw tags
    if (isNsfwLevel) {
      if (nsfwLevelIndex > clavataNsfwLevelTags.indexOf(highestNsfwTag.tag as ClavataNsfwLevelTag))
        highestNsfwTag = tag;
      return false;
    }

    return true;
  });

  // Add back nsfw tag
  tags.push(highestNsfwTag);

  return tags;
}

function processWDTags(tags: IncomingTag[]) {
  return tags.map((tag) => {
    tag.tag = tag.tag.replace(/_/g, ' ');
    return tag;
  });
}

const hiveProcessing = {
  ignore: ['general_not_nsfw_not_suggestive', 'natural'],
  map: {
    general_nsfw: 'nsfw',
    general_suggestive: 'suggestive',
  } as Record<string, string>,
};

function processHiveTags(tags: IncomingTag[]) {
  const results: IncomingTag[] = [];

  for (const tag of tags) {
    // Handle ignored tags
    if (tag.tag.startsWith('no_') || hiveProcessing.ignore.includes(tag.tag)) continue;

    // Clean tag name
    if (tag.tag.startsWith('yes_')) tag.tag = tag.tag.slice(4);
    else if (hiveProcessing.map[tag.tag]) tag.tag = hiveProcessing.map[tag.tag];
    tag.tag = tag.tag.replace(/_/g, ' ');

    results.push(tag);
  }
  return results;
}

// Moderation Rules
// --------------------------------------------------
type IngestedImage = {
  id: number;
  userId: number;
  prompt: string | null;
  metadata?: ImageMetadata | VideoMetadata | null;
};

async function applyModerationRules(image: IngestedImage) {
  const imageModRules = await getImagesModRules();
  const tags = await getTagNamesForImages([image.id]);

  if (imageModRules.length) {
    const appliedRule = evaluateRules(imageModRules, { ...image, tags: tags[image.id] });

    if (appliedRule) {
      const data =
        appliedRule.action === ModerationRuleAction.Block
          ? {
              ingestion: ImageIngestionStatus.Blocked,
              nsfwLevel: NsfwLevel.Blocked,
              blockedFor: BlockedReason.Moderated,
              needsReview: null,
            }
          : appliedRule.action === ModerationRuleAction.Hold
          ? { needsReview: 'modRule' }
          : undefined;
      if (data)
        await dbWrite.image.update({
          where: { id: image.id },
          data: {
            ...data,
            metadata: { ...image.metadata, ruleId: appliedRule.id, ruleReason: appliedRule.reason },
          },
        });

      // Send notification to user if auto blocked
      if (appliedRule.action === ModerationRuleAction.Block) {
        await createNotification({
          category: NotificationCategory.System,
          key: `image-block:${image.id}`,
          type: 'system-message',
          userId: image.userId,
          details: {
            message: `One of your images has been blocked due to a moderation rule violation${
              appliedRule.reason ? ` by the following reason: ${appliedRule.reason}` : ''
            }. If you believe this is a mistake, you can appeal this decision.`,
            url: `/images/${image.id}`,
          },
        }).catch((error) =>
          logToAxiom({
            name: 'image-scan-result',
            type: 'error',
            message: 'Could not create notification when blocking image',
            data: {
              imageId: image.id,
              error: error.message,
              cause: error.cause,
              stack: error.stack,
            },
          })
        );
      }

      return appliedRule;
    }
  }
}

// Tag Fetching
// --------------------------------------------------
async function getTagsFromIncomingTags({
  id,
  tags: incomingTags = [],
  source,
}: {
  id: number;
  tags: BodyProps['tags'];
  source: BodyProps['source'];
}) {
  if (!incomingTags) return;

  const image = await dbWrite.image.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      meta: true,
      metadata: true,
      postId: true,
      nsfwLevel: true,
      tools: {
        select: {
          toolId: true,
        },
      },
    },
  });
  if (!image) {
    await logScanResultError({ id, message: 'Image not found' });
    throw new Error('Image not found');
  }
  // Preprocess tags
  const preprocessor = tagPreprocessors[source];
  if (preprocessor) incomingTags = preprocessor(incomingTags);

  // Add prompt based tags
  const imageMeta = image.meta as Prisma.JsonObject | undefined;
  const prompt = imageMeta?.prompt as string | undefined;
  if (prompt) {
    // Detect real person in prompt
    const realPersonName = includesPoi(prompt);
    if (realPersonName) incomingTags.push({ tag: realPersonName.toLowerCase(), confidence: 100 });

    // Detect tags from prompt
    const promptTags = getTagsFromPrompt(prompt);
    if (promptTags) incomingTags.push(...promptTags.map((tag) => ({ tag, confidence: 70 })));
  }

  // De-dupe incoming tags and keep tag with highest confidence
  const tagMap: Record<string, IncomingTag> = {};
  for (const tag of incomingTags) {
    if (!tagMap[tag.tag] || tagMap[tag.tag].confidence < tag.confidence) tagMap[tag.tag] = tag;
  }
  const tags: Tag[] = Object.values(tagMap);

  // Add computed tags
  const computedTags = getComputedTags(
    tags.map((x) => x.tag),
    source
  );
  tags.push(...computedTags.map((x) => ({ tag: x, confidence: 70, source: TagSource.Computed })));

  // Apply Tag Rules
  const tagRules = await getTagRules();
  for (const rule of tagRules) {
    const match = tags.find((x) => x.tag === rule.toTag);
    if (!match) continue;

    if (rule.type === 'Replace') {
      match.id = rule.fromId;
      match.tag = rule.fromTag;
    } else if (rule.type === 'Append') {
      tags.push({ id: rule.fromId, tag: rule.fromTag, confidence: 70, source: TagSource.Computed });
    }
  }

  // Get Ids for tags
  const tagsToFind: string[] = [];
  let hasBlockedTag = false;
  for (const tag of tags) {
    const cachedTag = localTagCache[tag.tag];
    if (!cachedTag) tagsToFind.push(tag.tag);
    else {
      tag.id = cachedTag.id;
      if (!cachedTag.ignored && cachedTag.blocked) hasBlockedTag = true;
    }
  }

  // Get tags that we don't have cached
  if (tagsToFind.length > 0) {
    const foundTags = await dbWrite.tag.findMany({
      where: { name: { in: tagsToFind } },
      select: { id: true, name: true, nsfwLevel: true },
    });

    // Cache found tags and add ids to tags
    for (const tag of foundTags) {
      localTagCache[tag.name] = { id: tag.id };
      if (tag.nsfwLevel === NsfwLevel.Blocked) localTagCache[tag.name].blocked = true;
      if (shouldIgnore(tag.name, source)) localTagCache[tag.name].ignored = true;
    }

    for (const tag of tags) {
      const cachedTag = localTagCache[tag.tag];
      if (!cachedTag) continue;
      tag.id = cachedTag.id;
      if (!cachedTag.ignored && cachedTag.blocked) hasBlockedTag = true;
    }
  }

  // Add missing tags
  const newTags = tags.filter((x) => !x.id);
  if (newTags.length > 0) {
    await dbWrite.tag.createMany({
      data: newTags.map((x) => ({
        name: x.tag,
        type: TagType.Label,
        target:
          source === TagSource.WD14
            ? [TagTarget.Image]
            : [TagTarget.Image, TagTarget.Post, TagTarget.Model],
      })),
    });
    const newFoundTags = await dbWrite.tag.findMany({
      where: { name: { in: newTags.map((x) => x.tag) } },
      select: { id: true, name: true, nsfwLevel: true },
    });
    for (const tag of newFoundTags) {
      localTagCache[tag.name] = { id: tag.id };
      const match = tags.find((x) => x.tag === tag.name);
      if (match) match.id = tag.id;
    }
  }

  return { image, tags, hasBlockedTag };
}

// Review Condition Processing
// --------------------------------------------------
type Reviewer = 'moderators' | 'knights';
type ReviewConditionStored = {
  reviewer: Reviewer;
  condition: string;
};
type ReviewConditionContext = {
  tags: IncomingTag[];
  source: TagSource;
};
type ReviewConditionFn = {
  reviewer: Reviewer;
  condition: (tag: IncomingTag, ctx: ReviewConditionContext) => boolean;
};
type ReviewCondition = ReviewConditionStored | ReviewConditionFn;

const reviewConditions: ReviewCondition[] = [
  {
    condition: (tag, ctx) =>
      tag.tag === 'unconscious' && ctx.tags.some((t) => ['r', 'x', 'xxx'].includes(t.tag)),
    reviewer: 'moderators',
  },
  {
    condition: (tag, ctx) => tag.tag === 'bestiality' && ctx.tags.some((t) => t.tag === 'animal'),
    reviewer: 'moderators',
  },
  // {
  //   condition: (tag, ctx) => tag.tag === 'bestiality' && ctx.tags.some((t) => t.tag === 'animal'),
  //   reviewer: 'knights',
  // },
  {
    condition: (tag) => env.MODERATION_KNIGHT_TAGS.includes(tag.tag),
    reviewer: 'knights',
  },
];

export function determineReviewer(ctx: ReviewConditionContext) {
  for (const tag of ctx.tags) {
    for (const { condition, reviewer } of reviewConditions) {
      const conditionFn =
        typeof condition === 'function'
          ? condition
          : (new Function('tag', 'ctx', `return ${condition}`) as (
              tag: Tag,
              ctx: ReviewConditionContext
            ) => boolean);
      // Return the first action that matches
      if (conditionFn(tag, ctx)) return reviewer;
    }
  }
}
