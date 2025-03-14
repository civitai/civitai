import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { Prisma } from '@prisma/client';
import { TagSource } from '~/shared/utils/prisma/enums';
import { getComputedTags } from '~/server/utils/tag-rules';
import { insertTagsOnImageNew } from '~/server/services/tagsOnImageNew.service';
import { Limiter } from '~/server/utils/concurrency-helpers';

const importSchema = z.object({
  imageIds: z.string().transform((s) => s.split(',').map(Number)),
  wait: z.preprocess((val) => val === true || val === 'true', z.boolean()).optional(),
});

export default ModEndpoint(
  async function computeTags(req: NextApiRequest, res: NextApiResponse) {
    const { imageIds, wait } = importSchema.parse(req.query);
    const imageTags = await dbWrite.$queryRaw<{ tag: string; imageId: number }[]>`
      SELECT
        t.name "tag",
        toi."imageId"
      FROM "TagsOnImageDetails" toi
      JOIN "Tag" t ON toi."tagId" = t.id
      WHERE toi."imageId" IN (${Prisma.join(imageIds)})
    `;

    if (!wait) res.status(200).json({ images: imageIds.length });

    const images: Record<number, string[]> = {};
    for (const { tag, imageId } of imageTags) {
      if (!images[imageId]) images[imageId] = [];
      images[imageId].push(tag);
    }

    const toAdd: { imageId: number; tag: string }[] = [];
    for (const [imageId, tags] of Object.entries(images)) {
      const computedTags = getComputedTags(tags, TagSource.WD14);
      toAdd.push(...computedTags.map((tag) => ({ imageId: Number(imageId), tag })));
    }

    const toInsert = await Limiter().process(
      toAdd,
      (batch) => dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
      WITH image_tags AS (
        SELECT
          (value ->> 'imageId')::int AS id,
          value ->> 'tag' AS tag
        FROM json_array_elements(${JSON.stringify(batch)}::json)
      )
      SELECT it.id as "imageId", t.id as "tagId"
      FROM image_tags it
      JOIN "Tag" t ON t.name = it.tag;
    `
    );

    await insertTagsOnImageNew(
      toInsert.map(({ imageId, tagId }) => ({
        imageId,
        tagId,
        source: 'Computed',
        confidence: 70,
        automated: true,
      }))
    );

    console.log('Done adding computed tags!');

    if (wait) res.status(200).json({ images: imageIds.length });
  },
  ['GET']
);
