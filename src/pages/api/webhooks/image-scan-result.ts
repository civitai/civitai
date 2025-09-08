import { isDev } from '~/env/other';
import type { Prisma } from '@prisma/client';
import { uniqBy } from 'lodash-es';
import * as z from 'zod';
import { env } from '~/env/server';
import { tagsNeedingReview, tagsToIgnore } from '~/libs/tags';
import { clickhouse } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';
import {
  BlockedReason,
  ImageScanType,
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
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import { addImageToQueue } from '~/server/services/games/new-order.service';
import { createImageTagsForReview } from '~/server/services/image-review.service';
import {
  getImagesModRules,
  getTagNamesForImages,
  queueImageSearchIndexUpdate,
  imageScanTypes,
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
  MediaType,
  ModerationRuleAction,
  NewOrderRankType,
  TagSource,
  TagTarget,
  TagType,
} from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';
import { isValidAIGeneration } from '~/utils/image-utils';
import {
  auditMetaData,
  getTagsFromPrompt,
  includesInappropriate,
  includesPoi,
} from '~/utils/metadata/audit';
import poiWords from '~/utils/metadata/lists/words-poi.json';
import { normalizeText } from '~/utils/normalize-text';
import { removeEmpty } from '~/utils/object-helpers';
import { signalClient } from '~/utils/signal-client';
import { isDefined } from '~/utils/type-guards';

// const REQUIRED_SCANS = 2;

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
  status: z.enum(Status),
  source: z.enum(TagSource),
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

const KONO_NSFW_SAMPLING_RATE = 20;

export default WebhookEndpoint(async function imageTags(req, res) {
  if (req.method === 'GET' && req.query.imageId) {
    const imageId = Number(req.query.imageId);
    const image = await getImage(imageId);
    const result = await auditImageScanResults({ image });
    if (req.query.rescan) await updateImage(image, result);
    return res.status(200).json(result);
  }
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
    WHERE bitCount(bitXor(hash, ${hash})) < 5 AND disabled = false
  `;

  return count > 0;
}

async function handleSuccess(args: BodyProps) {
  const { id } = args;
  try {
    const scanned = await processScanResult(args);
    if (!scanned) return;

    // all scans have been processed
    const image = await getImage(id);
    if (image.ingestion === ImageIngestionStatus.Blocked) return;

    const result = await auditImageScanResults({ image });

    await updateImage(image, result);
  } catch (e: any) {
    await logScanResultError({ id, message: e.message, error: e });
    throw new Error(e.message);
  }
}

async function updateImage(
  image: GetImageReturn,
  { data, reviewKey, tagsForReview = [], flags }: AuditImageScanResultsReturn
) {
  const { id } = image;
  try {
    await dbWrite.image.update({ where: { id }, data });

    if (data.ingestion === 'Scanned') {
      if (reviewKey) {
        await Promise.all([
          // createImageForReview({ imageId: id, reason: reviewKey }),
          createImageTagsForReview({ imageId: id, tagIds: tagsForReview.map((x) => x.id) }),
        ]);
      }

      await tagIdsForImagesCache.refresh(id);

      const isProfilePicture = image.metadata?.profilePicture === true;
      if (isProfilePicture) {
        await deleteUserProfilePictureCache(image.userId);
      }

      // await dbWrite.$executeRaw`SELECT update_nsfw_level_new(${id}::int);`;
      if (image.postId) await updatePostNsfwLevel(image.postId);

      await queueImageSearchIndexUpdate({ ids: [id], action: SearchIndexUpdateQueueAction.Update });

      if (image.type === MediaType.image) {
        // #region [NewOrder]
        // New Order Queue Management. Only added when scan is succesful.
        const queueDetails: { priority: 1 | 2 | 3; rankType: NewOrderRankType } = {
          priority: 1,
          rankType: NewOrderRankType.Knight,
        };

        // Sampling logic: Only include 5% of NSFW images to reduce queue congestion
        let shouldAddToQueue = true;
        if (flags.nsfw) {
          queueDetails.priority = 2;
          // Use image ID for deterministic sampling (5% inclusion rate)
          shouldAddToQueue = id % KONO_NSFW_SAMPLING_RATE === 0; // 1/20 = 5%
        }

        if (reviewKey) {
          data.needsReview = reviewKey;
          queueDetails.rankType = NewOrderRankType.Templar;

          if (reviewKey === 'minor') queueDetails.priority = 1;
          if (reviewKey === 'poi') queueDetails.priority = 2;

          // never add images needing review regardless of sampling
          shouldAddToQueue = false;
        }

        if (shouldAddToQueue) {
          // TODO.newOrder: Priority 1 for knights is not being used for the most part. We might wanna change that based off of tags or smt.
          await addImageToQueue({
            imageIds: id,
            rankType: queueDetails.rankType,
            priority: queueDetails.priority,
          });
        }
        // #endregion
      }
    } else if (data.ingestion === 'Blocked') {
      await queueImageSearchIndexUpdate({ ids: [id], action: SearchIndexUpdateQueueAction.Delete });
    }

    if (data.ingestion && data.ingestion !== 'Blocked') {
      await signalClient.send({
        target: SignalMessages.ImageIngestionStatus,
        data: { imageId: image.id, ingestion: data.ingestion, blockedFor: data.blockedFor },
        userId: image.userId,
      });
    }
  } catch (e) {
    if (isDev) console.log({ error: e });
    throw e;
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
  await logToAxiom({
    name: 'image-scan-result',
    type: 'error',
    imageId: id,
    message,
    stack: error?.stack,
    cause: error?.cause,
  });
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
  urine: 60, // need to make it so that we can check wd14 tags for values that negate this tag - ie. cum
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
async function checkModerationRules(image: GetImageReturn, tags: TagDetails[]) {
  const imageModRules = await getImagesModRules();
  if (!imageModRules.length) return;

  const tagNames = tags.map((x) => x.name);
  const appliedRule = evaluateRules(imageModRules, { ...image.meta, tags: tagNames });
  if (!appliedRule || appliedRule.action === ModerationRuleAction.Approve) return;

  const data: Prisma.ImageUpdateInput = {
    metadata: { ...image.metadata, ruleId: appliedRule.id, ruleReason: appliedRule.reason },
  };
  if (appliedRule.action === ModerationRuleAction.Block) {
    data.ingestion = ImageIngestionStatus.Blocked;
    data.nsfwLevel = NsfwLevel.Blocked;
    data.blockedFor = BlockedReason.Moderated;
    data.needsReview = null;
  } else if (appliedRule.action === ModerationRuleAction.Hold) {
    data.needsReview = 'modRule';
  }

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

  return data;
}

type GetImageReturn = AsyncReturnType<typeof getImage>;
async function getImage(id: number) {
  const image = await dbWrite.image.findUnique({
    where: { id },
    select: {
      id: true,
      createdAt: true,
      scannedAt: true,
      type: true,
      userId: true,
      meta: true,
      metadata: true,
      postId: true,
      nsfwLevelLocked: true,
      scanJobs: true,
      ingestion: true,
      // nsfwLevel: true,
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
  return {
    ...image,
    meta: image.meta as Prisma.JsonObject | undefined,
    metadata: image.metadata as ImageMetadata | VideoMetadata | undefined,
    scanJobs: (image.scanJobs ?? {}) as { scans?: Record<string, TagSource> },
  };
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
  if (!incomingTags) {
    await logToAxiom({
      type: 'image-scan-result',
      message: 'No tags found',
      imageId: id,
      source,
    });
    return;
  }

  const image = await getImage(id);
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
  const blockedTags: number[] = [];
  for (const tag of tags) {
    const cachedTag = localTagCache[tag.tag];
    if (!cachedTag) tagsToFind.push(tag.tag);
    else {
      tag.id = cachedTag.id;
      if (!cachedTag.ignored && cachedTag.blocked) {
        hasBlockedTag = true;
        blockedTags.push(tag.id);
      }
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
      if (!cachedTag.ignored && cachedTag.blocked) {
        hasBlockedTag = true;
        blockedTags.push(tag.id);
      }
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
    const fn = source === TagSource.Clavata ? upsertTagsOnImageNew : insertTagsOnImageNew;
    await fn(toInsert);
  }

  return { image, tags, hasBlockedTag, blockedTags };
}

// Review Condition Processing
// --------------------------------------------------
type Reviewer = 'moderators' | 'knights';
type ReviewConditionStored = {
  reviewer: Reviewer;
  condition: string;
  tags?: string[];
};
type ReviewConditionContext = {
  tags: IncomingTag[];
};
type ReviewConditionFn = {
  reviewer: Reviewer;
  condition: (tag: IncomingTag, ctx: ReviewConditionContext) => boolean;
  tags?: string[];
};
type ReviewCondition = ReviewConditionStored | ReviewConditionFn;

const reviewConditions: ReviewCondition[] = [
  {
    condition: (tag, ctx) =>
      tag.tag === 'unconscious' && ctx.tags.some((t) => ['r', 'x', 'xxx'].includes(t.tag)),
    reviewer: 'moderators',
    tags: ['unconscious'],
  },
  {
    condition: (tag, ctx) => tag.tag === 'bestiality' && ctx.tags.some((t) => t.tag === 'animal'),
    reviewer: 'moderators',
    tags: ['bestiality'],
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
    for (const { condition, reviewer, tags = [] } of reviewConditions) {
      const conditionFn =
        typeof condition === 'function'
          ? condition
          : (new Function('tag', 'ctx', `return ${condition}`) as (
              tag: Tag,
              ctx: ReviewConditionContext
            ) => boolean);
      // Return the first action that matches
      if (conditionFn(tag, ctx)) return { reviewer, tagNames: tags };
    }
  }
}

type TagDetails = {
  id: number;
  name: string;
  nsfwLevel: number;
  confidence: number;
  disabled: boolean;
  blocked?: boolean;
};

const ImageScanTypeTagSourceMap = new Map([
  [ImageScanType.WD14, TagSource.WD14],
  [ImageScanType.Hash, TagSource.ImageHash],
  [ImageScanType.Hive, TagSource.Hive],
  [ImageScanType.MinorDetection, TagSource.MinorDetection],
  [ImageScanType.HiveDemographics, TagSource.HiveDemographics],
  [ImageScanType.Clavata, TagSource.Clavata],
]);

async function updateImageScanJobs({
  id,
  source,
  aiRating,
  aiModel,
  pHash,
  ingestion,
  nsfwLevel,
  blockedFor,
}: {
  id: number;
  source: TagSource;
  aiRating?: NsfwLevel;
  aiModel?: string;
  pHash?: bigint;
  ingestion?: ImageIngestionStatus;
  nsfwLevel?: NsfwLevel;
  blockedFor?: string;
}) {
  const result = await dbWrite.$queryRawUnsafe<
    {
      scanJobs: { scans?: Record<string, TagSource> };
    }[]
  >(`
      UPDATE "Image" SET
      ${pHash ? `"pHash" = ${pHash},` : ''}
      ${ingestion ? `"ingestion" = '${ingestion}',` : ''}
      ${nsfwLevel ? `"nsfwLevel" = ${nsfwLevel},` : ''}
      ${blockedFor ? `"blockedFor" = '${blockedFor}',` : ''}
      ${aiRating ? `"aiNsfwLevel" = ${aiRating},` : ''}
      ${aiModel ? `"aiModel" = '${aiModel}',` : ''}
      "scanJobs" = jsonb_set(COALESCE("scanJobs", '{}'), '{scans}', COALESCE("scanJobs"->'scans', '{}') || '{"${source}": ${Date.now()}}'::jsonb)
      WHERE id = ${id}
      RETURNING "scanJobs";
    `);

  return getHasRequiredScans(result[0]?.scanJobs?.scans);
}

const requiredScans = imageScanTypes
  .map((type) => ImageScanTypeTagSourceMap.get(type))
  .filter(isDefined);
function getHasRequiredScans(scans: Record<string, TagSource> = {}) {
  return requiredScans.every((scan) => scan in scans);
}

async function processScanResult({
  id,
  tags: incomingTags = [],
  source,
  context,
  hash,
  result,
}: BodyProps) {
  switch (source) {
    case TagSource.ImageHash: {
      if (!hash) throw new Error('missing hash from ImageHash scan');
      const blocked = await isBlocked(hash);
      const pHash = BigInt(hash);
      if (!blocked) return await updateImageScanJobs({ id, source, pHash });
      else
        return await updateImageScanJobs({
          id,
          source,
          pHash,
          ingestion: ImageIngestionStatus.Blocked,
          nsfwLevel: NsfwLevel.Blocked,
          blockedFor: 'Similar to blocked content',
        });
    }
    case TagSource.WD14:
    case TagSource.Clavata: {
      await getTagsFromIncomingTags({ id, source, tags: incomingTags });

      // Add to scanJobs and update aiRating
      let aiRating: NsfwLevel | undefined;
      let aiModel: string | undefined;
      if (source === TagSource.WD14 && !!context?.movie_rating) {
        aiRating = NsfwLevel[context.movie_rating as keyof typeof NsfwLevel];
        aiModel = context.movie_rating_model_id;
      }

      return await updateImageScanJobs({ id, source, aiRating, aiModel });
    }
    default:
      throw new Error(`unhandled image scan type: ${source}`);
  }
}

type AuditImageScanResultsReturn = AsyncReturnType<typeof auditImageScanResults>;
async function auditImageScanResults({ image }: { image: GetImageReturn }) {
  const prompt = normalizeText(image.meta?.['prompt'] as string | undefined);
  const negativePrompt = normalizeText(image.meta?.['negativePrompt'] as string | undefined);

  const tagsFromTagsOnImageDetails = await dbWrite.$queryRaw<
    { id: number; name: string; nsfwLevel: number; confidence: number; disabled: boolean }[]
  >`
      SELECT t.id, t.name, t."nsfwLevel", toi.confidence, toi.disabled
      FROM "TagsOnImageDetails" toi
      JOIN "Tag" t ON t.id = toi."tagId"
      WHERE toi."imageId" = ${image.id} AND toi.automated AND NOT toi.disabled
    `;
  const tags = tagsFromTagsOnImageDetails.map((tag) => ({
    ...tag,
    blocked: tag.nsfwLevel === NsfwLevel.Blocked,
  }));
  const nsfwLevel = Math.max(...[...tags.map((x) => x.nsfwLevel), 0]);

  // Check if image has restricted base models using materialized view
  const [{ hasRestrictedBaseModel }] = await dbRead.$queryRaw<
    { hasRestrictedBaseModel: boolean }[]
  >`
    SELECT EXISTS (
      SELECT 1 FROM "RestrictedImagesByBaseModel" ribm
      WHERE ribm."imageId" = ${image.id}
    ) as "hasRestrictedBaseModel"
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
    modRuleReview: false,
  };

  const minorTags: TagDetails[] = [];
  const poiTags: TagDetails[] = tags.filter((tag) => poiWords.includes(tag.name.toLowerCase()));
  const reviewTags: TagDetails[] = tags.filter((x) => x.blocked);
  const hasBlockedTag = reviewTags.length > 0;

  for (const tag of tags) {
    if (nsfwLevel > sfwBrowsingLevelsFlag) flags.nsfw = true;
    if (tagsNeedingReview.includes(tag.name)) {
      flags.hasMinorTag = true;
      flags.minor = true;
      minorTags.push(tag);
    } else if (constants.imageTags.styles.includes(tag.name)) flags.hasCartoonTag = true;
    else if (['adult'].includes(tag.name)) flags.hasAdultTag = true;
  }

  const clavataNsfwLevel = tags.find((x) =>
    clavataNsfwLevelTags.includes(x.name as ClavataNsfwLevelTag)
  )?.name as ClavataNsfwLevelTag | undefined;

  const child10 = tags.find((x) => x.name === 'child-10');
  const child13 = tags.find((x) => x.name === 'child-13');
  const child15 = tags.find((x) => x.name === 'child-15');
  const realistic = tags.find((x) => x.name === 'realistic');
  const potentialCelebrity = tags.find((x) => x.name === 'potential celebrity');

  if (clavataNsfwLevel) {
    switch (clavataNsfwLevel) {
      case 'pg':
        if (child10) flags.minor = true;
        if (realistic && child15) {
          flags.minor = true;
          flags.minorReview = true;
          minorTags.push(realistic, child15);
        }
        break;
      case 'pg-13':
      case 'r':
      case 'x':
      case 'xxx':
        if (child10) {
          flags.minor = true;
          flags.minorReview = true;
          minorTags.push(child10);
        }
        if ((child10 || child13 || child15) && realistic) {
          flags.minor = true;
          flags.minorReview = true;
          minorTags.push(...[child10, child13, child15, realistic].filter(isDefined));
        }
        break;
    }

    if (potentialCelebrity) {
      flags.poiReview = true;
      poiTags.push(potentialCelebrity);
    }
  }

  if (poiTags.length > 0) {
    flags.poiReview = true;
  }

  const inappropriate = includesInappropriate({ prompt, negativePrompt }, flags.nsfw);
  if (inappropriate === 'minor') flags.minorReview = true;
  if (inappropriate === 'poi') flags.poiReview = true;
  if (prompt && includesPoi(prompt)) flags.poi = true;
  if (hasBlockedTag) flags.tagReview = true;

  // TODO - add information to ImageForReview entity based on any connected entities
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
      (await dbWrite.$queryRaw<{ isNewUser: boolean }[]>`
        SELECT is_new_user(CAST(${image.userId} AS INT)) "isNewUser";
      `) ?? [];
    if (isNewUser) flags.newUserReview = true;
  }

  const reviewerResult = determineReviewer({
    tags: tags.map((tag) => ({ ...tag, tag: tag.name })),
  });
  if (reviewerResult) {
    const { reviewer, tagNames } = reviewerResult;
    if (reviewer === 'moderators') {
      flags.tagReview = true;
      reviewTags.push(...tags.filter((x) => tagNames.includes(x.name)));
    } else if (reviewer === 'knights') {
      // TODO @manuelurenah - Add knight review logic
    }
  }

  if (flags.poiReview) reviewKey = 'poi';
  else if (flags.minorReview) reviewKey = 'minor';
  else if (flags.tagReview) reviewKey = 'tag';
  else if (flags.newUserReview) reviewKey = 'newUser';

  const data: Prisma.ImageUpdateInput = {
    ingestion: getHasRequiredScans(image.scanJobs?.scans)
      ? ImageIngestionStatus.Scanned
      : undefined,
    updatedAt: new Date(),
  };
  if (!image.nsfwLevelLocked) data.nsfwLevel = nsfwLevel;
  if (flags.poi) data.poi = true;
  if (flags.minor) data.minor = true;

  const validAiGeneration = isValidAIGeneration({
    ...image,
    nsfwLevel: Math.max(nsfwLevel, flags.nsfw ? NsfwLevel.X : NsfwLevel.PG),
    meta: image.meta as ImageMetadata | VideoMetadata,
    tools: image.tools,
    // Avoids blocking images that we know are AI generated with some resources.
    resources: hasResource ? [1] : [],
  });
  if (flags.nsfw && !validAiGeneration) {
    data.ingestion = ImageIngestionStatus.Blocked;
    data.blockedFor = BlockedReason.AiNotVerified;
  }

  if (flags.nsfw && hasRestrictedBaseModel) {
    data.ingestion = ImageIngestionStatus.Blocked;
    data.blockedFor = BlockedReason.TOS;
  }

  if (flags.nsfw && prompt && data.ingestion !== ImageIngestionStatus.Blocked) {
    // Determine if we need to block the image
    const { success, blockedFor } = auditMetaData({ prompt }, flags.nsfw);
    if (!success) {
      data.ingestion = ImageIngestionStatus.Blocked;
      data.blockedFor = blockedFor?.join(',') ?? 'Failed audit, no explanation';
    }
  }

  if (data.ingestion === ImageIngestionStatus.Scanned) {
    // only set "needsReview" if the scan is successful
    if (reviewKey) data.needsReview = reviewKey;

    const createdAtTime = new Date(image.createdAt).getTime();
    const now = new Date();
    const oneWeekAgo = decreaseDate(now, 7, 'days').getTime();
    if (!image.scannedAt) data.scannedAt = now;
    else if (!image.metadata?.skipScannedAtReassignment && createdAtTime >= oneWeekAgo)
      data.scannedAt = now;
  }

  const moderationRulesImageData = await checkModerationRules(image, tags);
  if (typeof moderationRulesImageData?.needsReview === 'string')
    reviewKey = moderationRulesImageData?.needsReview;

  return {
    prompt,
    data: removeEmpty({ ...data, ...moderationRulesImageData }),
    flags,
    reviewKey,
    tagsForReview: [...minorTags, ...poiTags, ...reviewTags],
    scans: image.scanJobs.scans,
  };
}
