import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { ImageIngestionStatus, Prisma, TagSource, TagTarget, TagType } from '@prisma/client';
import {
  auditMetaData,
  getTagsFromPrompt,
  includesInappropriate,
  includesPoi,
} from '~/utils/metadata/audit';
import { topLevelModerationCategories } from '~/libs/moderation';
import { tagsNeedingReview as minorTags, tagsToIgnore } from '~/libs/tags';
import { logToDb } from '~/utils/logging';
import { constants } from '~/server/common/constants';
import { getComputedTags } from '~/server/utils/tag-rules';
import { updatePostNsfwLevel } from '~/server/services/post.service';
import { imagesSearchIndex } from '~/server/search-index';
import { deleteUserProfilePictureCache } from '~/server/services/user.service';
import { updateImageTagIdsForImages } from '~/server/services/image.service';
import { signalClient } from '~/utils/signal-client';
import { SignalMessages, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { scanJobsSchema } from '~/server/schema/image.schema';
import { getTagRules } from '~/server/services/system-cache';
import { uniqBy } from 'lodash-es';
import { NsfwLevel } from '~/server/common/enums';
import { logToAxiom } from '~/server/logging/client';
import { normalizeText } from '~/utils/string-helpers';

const REQUIRED_SCANS = [TagSource.WD14, TagSource.Rekognition];

const tagCache: Record<string, number> = {};

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
  vectors: z.array(z.number().array()).nullish(),
  status: z.nativeEnum(Status),
  source: z.nativeEnum(TagSource),
  context: z
    .object({
      movie_rating: z.string().optional(),
      movie_rating_model_id: z.string().optional(),
    })
    .nullish(),
});

function shouldIgnore(tag: string, source: TagSource) {
  return (
    (tagsToIgnore[source]?.includes(tag) ?? false) || topLevelModerationCategories.includes(tag)
  );
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
async function handleSuccess({ id, tags: incomingTags = [], source, context }: BodyProps) {
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

  // Handle underscores coming out of WD14
  if (source === TagSource.WD14) {
    for (const tag of incomingTags) tag.tag = tag.tag.replace(/_/g, ' ');
  }

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
  for (const tag of tags) {
    tag.id = tagCache[tag.tag];
    if (!tag.id) tagsToFind.push(tag.tag);
  }

  // Get tags that we don't have cached
  if (tagsToFind.length > 0) {
    const foundTags = await dbWrite.tag.findMany({
      where: { name: { in: tagsToFind } },
      select: { id: true, name: true },
    });

    // Cache found tags and add ids to tags
    for (const tag of foundTags) tagCache[tag.name] = tag.id;
    for (const tag of tags) tag.id = tagCache[tag.tag];
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
      select: { id: true, name: true },
    });
    for (const tag of newFoundTags) {
      tagCache[tag.name] = tag.id;
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
          where: { imageId: id, automated: true, disabled: false },
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

    let reviewKey: string | null = null;
    const inappropriate = includesInappropriate(prompt, nsfw);
    if (inappropriate !== false) reviewKey = inappropriate;
    if (!reviewKey && nsfw) {
      const [{ poi }] = await dbWrite.$queryRaw<{ poi: boolean }[]>`
        WITH to_check AS (
          -- Check based on associated resources
          SELECT
            COUNT(*) > 0 "poi"
          FROM "ImageResource" ir
          JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
          JOIN "Model" m ON m.id = mv."modelId"
          WHERE ir."imageId" = ${image.id} AND m.poi
          UNION
          -- Check based on associated bounties
          SELECT
            SUM(IIF(b.poi, 1, 0)) > 0 "poi"
          FROM "Image" i
          JOIN "ImageConnection" ic ON ic."imageId" = i.id
          JOIN "Bounty" b ON ic."entityType" = 'Bounty' AND b.id = ic."entityId"
          WHERE ic."imageId" = ${image.id}
          UNION
          -- Check based on associated bounty entries
          SELECT
            SUM(IIF(b.poi, 1, 0)) > 0 "poi"
          FROM "Image" i
          JOIN "ImageConnection" ic ON ic."imageId" = i.id
          JOIN "BountyEntry" be ON ic."entityType" = 'BountyEntry' AND be.id = ic."entityId"
          JOIN "Bounty" b ON b.id = be."bountyId"
          WHERE ic."imageId" = ${image.id}
        )
        SELECT bool_or(poi) "poi" FROM to_check;
      `;
      if (poi) reviewKey = 'poi';
    }
    if (!reviewKey && hasMinorTag && !hasAdultTag && (!hasCartoonTag || nsfw)) {
      reviewKey = 'minor';
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
        UPDATE "Image" i SET "scannedAt" = NOW(), "ingestion" ='Scanned'
        FROM scan_count s
        WHERE s.id = i.id AND s.count >= ${REQUIRED_SCANS.length}
        RETURNING "ingestion";
      `;
      data.ingestion = ingestion;

      if (ingestion === 'Scanned') {
        // Clear cached image tags after completing scans
        await updateImageTagIdsForImages(id);

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
