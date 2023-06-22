import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { ImageIngestionStatus, Prisma, TagTarget, TagType } from '@prisma/client';
import { auditMetaData } from '~/utils/image-metadata';
import { topLevelModerationCategories } from '~/libs/moderation';
import { tagsNeedingReview } from '~/libs/tags';

const tagCache: Record<string, number> = {};

enum Status {
  Success = 0,
  NotFound = 1, // image not found at url
  Unscannable = 2,
}

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
  tags: tagSchema.array().optional(),
  status: z.nativeEnum(Status),
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
        await dbWrite.image.update({
          where: { id: data.id },
          data: { ingestion: ImageIngestionStatus.NotFound },
        });
        break;
      case Status.Unscannable:
        await dbWrite.image.update({
          where: { id: data.id },
          data: { ingestion: ImageIngestionStatus.Error },
        });
        break;
      case Status.Success:
        await handleSuccess(data);
        break;
      default: {
        throw new Error('unhandled data type');
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(400).send({ error: e.message });
  }
});

type ComputedTagTester = {
  includesAll?: string[];
  includesSome?: string[];
  excludes?: string[];
};
const computedTagCombos: Record<string, ComputedTagTester> = {
  'female swimwear or underwear': {
    includesAll: ['female'],
    includesSome: ['swimwear', 'underwear', 'lingerie', 'bikini'],
    excludes: [
      'dress',
      'nudity',
      'illustrated explicit nudity',
      'partial nudity',
      'sexual activity',
      'graphic female nudity',
    ],
  },
  'male swimwear or underwear': {
    includesAll: ['male'],
    includesSome: ['swimwear', 'underwear', 'lingerie'],
    excludes: [
      'dress',
      'nudity',
      'illustrated explicit nudity',
      'partial nudity',
      'sexual activity',
      'graphic male nudity',
    ],
  },
};

const computedTagsCombosArray = Object.entries(computedTagCombos);
async function handleSuccess({ id, tags: incomingTags = [] }: BodyProps) {
  if (!incomingTags.length) return;

  // De-dupe incoming tags and keep tag with highest confidence
  const tagMap: Record<string, IncomingTag> = {};
  for (const tag of incomingTags) {
    if (!tagMap[tag.tag] || tagMap[tag.tag].confidence < tag.confidence) tagMap[tag.tag] = tag;
  }
  const tags = Object.values(tagMap);

  // Add computed tags
  for (const [toAdd, { includesAll, includesSome, excludes }] of computedTagsCombosArray) {
    if (tags.some((x) => x.tag === toAdd)) continue;
    if (includesAll && !includesAll.every((x) => tags.some((y) => y.tag === x))) continue;
    if (includesSome && !includesSome.some((x) => tags.some((y) => y.tag === x))) continue;
    if (excludes && excludes.some((x) => tags.some((y) => y.tag === x))) continue;
    tags.push({ tag: toAdd, confidence: 70 });
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
        target: [TagTarget.Image, TagTarget.Post, TagTarget.Model],
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
    select: { id: true, meta: true },
  });
  if (!image) throw new Error('Image not found');

  try {
    await dbWrite.$executeRawUnsafe(`
      INSERT INTO "TagsOnImage" ("imageId", "tagId", "confidence", "automated", "disabled")
      VALUES ${tags
        .filter((x) => x.id)
        .map((x) => `(${id}, ${x.id}, ${x.confidence}, true, ${isModerationCategory(x.tag)})`)
        .join(', ')}
      ON CONFLICT ("imageId", "tagId") DO UPDATE SET "confidence" = EXCLUDED."confidence";
    `);
  } catch (e: any) {
    throw new Error(e.message);
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
      hasAnimatedTag = false,
      nsfw = false;
    for (const { name, type } of tags) {
      if (type === TagType.Moderation) nsfw = true;
      if (tagsNeedingReview.includes(name)) hasMinorTag = true;
      else if (['anime', 'cartoon', 'comics', 'manga'].includes(name)) hasAnimatedTag = true;
      else if (['adult'].includes(name)) hasAdultTag = true;
    }

    // Set scannedAt and needsReview
    const shouldReview = hasMinorTag && !hasAdultTag && (!hasAnimatedTag || nsfw);
    const prompt = (image.meta as Prisma.JsonObject)?.['prompt'] as string | undefined;

    const data: Prisma.ImageUpdateInput = {
      scannedAt: new Date(),
      needsReview: shouldReview ? true : undefined,
      ingestion: ImageIngestionStatus.Scanned,
    };

    if (nsfw && prompt) {
      const { success, blockedFor } = auditMetaData({ prompt }, nsfw);
      if (!success) {
        data.ingestion = ImageIngestionStatus.Blocked;
        data.blockedFor = blockedFor.join(',');
      }
    }

    await dbWrite.image.updateMany({
      where: { id },
      data,
    });

    // Set nsfw level
    await dbWrite.$executeRaw`SELECT update_nsfw_level(${id}::int);`;
  } catch (e: any) {
    throw new Error(e.message);
  }
}
