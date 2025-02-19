import { Prisma } from '@prisma/client';
import { uniqBy } from 'lodash-es';
import { z } from 'zod';
import { env } from '~/env/server';
import { tagsNeedingReview as minorTags, tagsToIgnore } from '~/libs/tags';
import { clickhouse } from '~/server/clickhouse/client';
import { constants } from '~/server/common/constants';
import { NsfwLevel, SearchIndexUpdateQueueAction, SignalMessages } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { tagIdsForImagesCache } from '~/server/redis/caches';
import { scanJobsSchema } from '~/server/schema/image.schema';
import { imagesMetricsSearchIndex, imagesSearchIndex } from '~/server/search-index';
import { updatePostNsfwLevel } from '~/server/services/post.service';
import { getTagRules } from '~/server/services/system-cache';
import { deleteUserProfilePictureCache } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getComputedTags } from '~/server/utils/tag-rules';
import { ImageIngestionStatus, TagSource, TagTarget, TagType } from '~/shared/utils/prisma/enums';
import { logToDb } from '~/utils/logging';
import {
  auditMetaData,
  getTagsFromPrompt,
  includesInappropriate,
  includesPoi,
} from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/normalize-text';
import { signalClient } from '~/utils/signal-client';

const REQUIRED_SCANS = 2;

const tagCache: Record<string, { id: number; blocked?: true; ignored?: true }> = {};

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

  if (!incomingTags) return;

  const image = await dbWrite.image.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      meta: true,
      metadata: true,
      postId: true,
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
    const cachedTag = tagCache[tag.tag];
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
      tagCache[tag.name] = { id: tag.id };
      if (tag.nsfwLevel === NsfwLevel.Blocked) tagCache[tag.name].blocked = true;
      if (shouldIgnore(tag.name, source)) tagCache[tag.name].ignored = true;
    }

    for (const tag of tags) {
      const cachedTag = tagCache[tag.tag];
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
      tagCache[tag.name] = { id: tag.id };
      const match = tags.find((x) => x.tag === tag.name);
      if (match) match.id = tag.id;
    }
  }

  try {
    if (tags.length > 0) {
      const uniqTags = uniqBy(tags, (x) => x.id);
      await dbWrite.$executeRawUnsafe(`
        INSERT INTO "TagsOnImage" ("imageId", "tagId", "confidence", "automated", "disabled", "source")
        VALUES ${uniqTags
          .filter((x) => x.id)
          .map(
            (x) =>
              `(${id}, ${x.id}, ${x.confidence}, true, ${shouldIgnore(
                x.tag,
                x.source ?? source
              )}, '${x.source ?? source}')`
          )
          .join(', ')}
        ON CONFLICT ("imageId", "tagId") DO UPDATE SET "confidence" = EXCLUDED."confidence";
      `);
    } else {
      logToAxiom({ type: 'image-scan-result', message: 'No tags found', imageId: id, source });
    }

    // Mark image as scanned and set the nsfw field based on the presence of automated tags with type 'Moderation'
    const tagsOnImage =
      (
        await dbWrite.tagsOnImage.findMany({
          where: { imageId: id, automated: true, disabledAt: null },
          select: { tag: { select: { type: true, name: true } } },
        })
      )?.map((x) => x.tag) ?? [];

    let hasAdultTag = false,
      hasMinorTag = false,
      hasCartoonTag = false,
      nsfw = false;
    for (const { name, type } of tagsOnImage) {
      if (type === TagType.Moderation) nsfw = true;
      if (minorTags.includes(name)) hasMinorTag = true;
      else if (constants.imageTags.styles.includes(name)) hasCartoonTag = true;
      else if (['adult'].includes(name)) hasAdultTag = true;
    }

    const prompt = normalizeText(
      (image.meta as Prisma.JsonObject)?.['prompt'] as string | undefined
    );
    const negativePrompt = normalizeText(
      (image.meta as Prisma.JsonObject)?.['negativePrompt'] as string | undefined
    );

    let reviewKey: string | null = null;
    const inappropriate = includesInappropriate({ prompt, negativePrompt }, nsfw);
    if (inappropriate !== false) reviewKey = inappropriate;
    if (!reviewKey && hasBlockedTag) reviewKey = 'tag';
    if (!reviewKey && nsfw) {
      const [{ poi, minor }] = await dbWrite.$queryRaw<{ poi: boolean; minor: boolean }[]>`
        WITH to_check AS (
          -- Check based on associated resources
          SELECT
            SUM(IIF(m.poi, 1, 0)) > 0 "poi",
            SUM(IIF(m.minor, 1, 0)) > 0 "minor"
          FROM "ImageResource" ir
          JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
          JOIN "Model" m ON m.id = mv."modelId"
          WHERE ir."imageId" = ${image.id}
          UNION
          -- Check based on associated bounties
          SELECT
            SUM(IIF(b.poi, 1, 0)) > 0 "poi",
            false "minor"
          FROM "Image" i
          JOIN "ImageConnection" ic ON ic."imageId" = i.id
          JOIN "Bounty" b ON ic."entityType" = 'Bounty' AND b.id = ic."entityId"
          WHERE ic."imageId" = ${image.id}
          UNION
          -- Check based on associated bounty entries
          SELECT
            SUM(IIF(b.poi, 1, 0)) > 0 "poi",
            false "minor"
          FROM "Image" i
          JOIN "ImageConnection" ic ON ic."imageId" = i.id
          JOIN "BountyEntry" be ON ic."entityType" = 'BountyEntry' AND be.id = ic."entityId"
          JOIN "Bounty" b ON b.id = be."bountyId"
          WHERE ic."imageId" = ${image.id}
        )
        SELECT bool_or(poi) "poi", bool_or(minor) "minor" FROM to_check;
      `;
      if (minor) reviewKey = 'minor';
      if (poi) reviewKey = 'poi';
    }
    if (!reviewKey && hasMinorTag && !hasAdultTag && (!hasCartoonTag || nsfw)) {
      reviewKey = 'minor';
    }
    if (!reviewKey && nsfw) {
      // If user is new and image is NSFW send it for review
      const [{ isNewUser }] =
        (await dbRead.$queryRaw<{ isNewUser: boolean }[]>`
        SELECT is_new_user(CAST(${image.userId} AS INT)) "isNewUser";
      `) ?? [];
      if (isNewUser) reviewKey = 'newUser';
    }

    const data: Prisma.ImageUpdateInput = {};
    if (reviewKey) data.needsReview = reviewKey;

    if (nsfw && prompt) {
      // Determine if we need to block the image
      const { success, blockedFor } = auditMetaData({ prompt }, nsfw);
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
        UPDATE "Image" i SET "scannedAt" = NOW(), "updatedAt" = NOW(), "createdAt" = NOW(), "ingestion" ='Scanned'
        FROM scan_count s
        WHERE s.id = i.id AND s.count >= ${REQUIRED_SCANS}
        RETURNING "ingestion";
      `;
      data.ingestion = ingestion;

      if (ingestion === 'Scanned') {
        // Clear cached image tags after completing scans
        await tagIdsForImagesCache.refresh(id);

        const imageMetadata = image.metadata as Prisma.JsonObject | undefined;
        const isProfilePicture = imageMetadata?.profilePicture === true;
        if (isProfilePicture) {
          await deleteUserProfilePictureCache(image.userId);
        }

        await dbWrite.$executeRaw`SELECT update_nsfw_level(${id}::int);`;
        if (image.postId) await updatePostNsfwLevel(image.postId);

        // Update search index
        await imagesSearchIndex.queueUpdate([
          {
            id,
            action: SearchIndexUpdateQueueAction.Update,
          },
        ]);
        await imagesMetricsSearchIndex.queueUpdate([
          {
            id,
            action: SearchIndexUpdateQueueAction.Update,
          },
        ]);
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
  await logToDb('image-scan-result', {
    type: 'error',
    imageId: id,
    message,
    error,
  });
}

// Tag Preprocessing
// --------------------------------------------------
const tagPreprocessors: Partial<Record<TagSource, (tags: IncomingTag[]) => IncomingTag[]>> = {
  [TagSource.WD14]: processWDTags,
  [TagSource.Hive]: processHiveTags,
};

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
