import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { ImageIngestionStatus, Prisma, TagSource, TagTarget, TagType } from '@prisma/client';
import { auditMetaData } from '~/utils/metadata/audit';
import { topLevelModerationCategories } from '~/libs/moderation';
import { tagsNeedingReview } from '~/libs/tags';
import { logToDb } from '~/utils/logging';
import { constants } from '~/server/common/constants';
import { getComputedTags } from '~/server/utils/tag-computation';

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
});

function isModerationCategory(tag: string) {
  return topLevelModerationCategories.includes(tag);
}

export default WebhookEndpoint(async function imageTags(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  const bodyResults = schema.safeParse(req.body);
  if (!bodyResults.success)
    return res
      .status(400)
      .json({ ok: false, error: `Invalid body: ${bodyResults.error.flatten().fieldErrors}` });

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
        await dbWrite.image.updateMany({
          where: { id: data.id, ingestion: { in: pendingStates } },
          data: { ingestion: ImageIngestionStatus.Error },
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
async function handleSuccess({ id, tags: incomingTags = [], source }: BodyProps) {
  if (!incomingTags?.length) return;

  // Handle underscores coming out of WD14
  if (source === TagSource.WD14) {
    for (const tag of incomingTags) tag.tag = tag.tag.replace(/_/g, ' ');
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

  const image = await dbWrite.image.findUnique({
    where: { id },
    select: {
      id: true,
      meta: true,
    },
  });

  if (!image) {
    await logScanResultError({ id, message: 'Image not found' });
    throw new Error('Image not found');
  }

  try {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnImage" ("imageId", "tagId", "confidence", "automated", "disabled", "source")
      VALUES ${tags
        .filter((x) => x.id)
        .map(
          (x) =>
            `(${id}, ${x.id}, ${x.confidence}, true, ${isModerationCategory(x.tag)}, '${
              x.source ?? source
            }')`
        )
        .join(', ')}
      ON CONFLICT ("imageId", "tagId") DO UPDATE SET "confidence" = EXCLUDED."confidence";
    `);
  } catch (e: any) {
    await logScanResultError({ id, message: e.message, error: e });
    throw new Error(e.message);
  }

  // For now, only update the scanned state if we got the result from Rekognition
  if (source === TagSource.WD14) {
    // However we can still update the nsfw level, as it will only go up...
    await dbWrite.$executeRaw`SELECT update_nsfw_level(${id}::int);`;
    return;
  }

  try {
    // Mark image as scanned and set the nsfw field based on the presence of automated tags with type 'Moderation'
    const tags =
      (
        await dbWrite.tagsOnImage.findMany({
          where: { imageId: id, automated: true },
          select: { tag: { select: { type: true, name: true } } },
        })
      )?.map((x) => x.tag) ?? [];

    let hasAdultTag = false,
      hasMinorTag = false,
      hasCartoonTag = false,
      nsfw = false;
    for (const { name, type } of tags) {
      if (type === TagType.Moderation) nsfw = true;
      if (tagsNeedingReview.includes(name)) hasMinorTag = true;
      else if (constants.imageTags.styles.includes(name)) hasCartoonTag = true;
      else if (['adult'].includes(name)) hasAdultTag = true;
    }

    let reviewKey: string | null = null;
    if (hasMinorTag && !hasAdultTag && (!hasCartoonTag || nsfw)) reviewKey = 'minor';
    else if (nsfw) {
      const [{ poi }] = await dbWrite.$queryRaw<{ poi: boolean }[]>`
        SELECT
          COUNT(*) > 0 "poi"
        FROM "ImageResource" ir
        JOIN "ModelVersion" mv ON ir."modelVersionId" = mv.id
        JOIN "Model" m ON m.id = mv."modelId"
        WHERE ir."imageId" = ${image.id} AND m.poi
      `;
      if (poi) reviewKey = 'poi';
    }
    const prompt = (image.meta as Prisma.JsonObject)?.['prompt'] as string | undefined;

    const data: Prisma.ImageUpdateInput = {
      scannedAt: new Date(),
      needsReview: reviewKey,
      ingestion: ImageIngestionStatus.Scanned,
    };

    if (nsfw && prompt) {
      const { success, blockedFor } = auditMetaData({ prompt }, nsfw);
      if (!success) {
        data.ingestion = ImageIngestionStatus.Blocked;
        data.blockedFor = blockedFor.join(',');
      }
    }

    // Set nsfw level
    // do this before updating the image with the new ingestion status
    await dbWrite.$executeRaw`SELECT update_nsfw_level(${id}::int);`;

    await dbWrite.image.updateMany({
      where: { id },
      data,
    });
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
