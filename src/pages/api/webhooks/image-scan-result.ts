import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { TagTarget, TagType } from '@prisma/client';

const tagSchema = z.object({
  tag: z.string(),
  id: z.number().optional(),
  confidence: z.number(),
});
const bodySchema = z.object({
  id: z.number(),
  tags: z.array(tagSchema),
});
const tagCache: Record<string, number> = {};

export default WebhookEndpoint(async function imageTags(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const bodyResults = bodySchema.safeParse(req.body);
  if (!bodyResults.success)
    return res
      .status(400)
      .json({ error: `Invalid body: ${bodyResults.error.flatten().fieldErrors}` });
  const { id: imageId, tags } = bodyResults.data;

  // Clear automated tags
  await dbWrite.tagsOnImage.deleteMany({
    where: { imageId, automated: true },
  });

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
    for (const tag of foundTags) {
      tagCache[tag.name] = tag.id;
      const match = tags.find((x) => x.tag === tag.name);
      if (match) match.id = tag.id;
    }
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

  // Add new automated tags to image
  try {
    await dbWrite.tagsOnImage.createMany({
      data: tags
        .filter((x) => x.id)
        .map((x) => ({
          imageId,
          tagId: x.id as number,
          confidence: x.confidence,
          automated: true,
        })),
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }

  try {
    // Mark image as scanned
    await dbWrite.image.updateMany({
      where: { id: imageId },
      data: { scannedAt: new Date() },
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }

  res.status(200).json({ ok: true });
});
