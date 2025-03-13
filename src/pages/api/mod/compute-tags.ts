import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { Prisma } from '@prisma/client';
import { TagSource } from '~/shared/utils/prisma/enums';
import { chunk } from 'lodash-es';
import { getComputedTags } from '~/server/utils/tag-rules';

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

    const batchSize = 1000;
    const batches = chunk(toAdd, batchSize);
    let i = 0;
    for (const batch of batches) {
      console.log(
        `Adding batch ${i} to ${Math.min(i + batchSize, toAdd.length)} of ${toAdd.length} tags`
      );
      const json = JSON.stringify(batch);

      // TODO.TagsOnImage - create a function that accepst the result of `insert_tag_on_image` and `upsert_tag_on_image` and calls update_nsfw_levels with the resulting image ids
      await dbWrite.$queryRaw`
        WITH image_tags AS (
          SELECT
            (value ->> 'imageId')::int AS id,
            value ->> 'tag' AS tag
          FROM json_array_elements(${json}::json)
        )
        SELECT (insert_tag_on_image(it.id, t.id, 'Computed', 70, true)).*
        FROM image_tags it
        JOIN "Tag" t ON t.name = it.tag;
      `;

      // Recompute the nsfw level
      const imageIds = batch.map((x) => x.imageId);
      await dbWrite.$executeRawUnsafe(
        `SELECT update_nsfw_levels('{${imageIds.join(',')}}'::int[]);`
      );

      i += batchSize;
    }
    console.log('Done adding computed tags!');

    if (wait) res.status(200).json({ images: imageIds.length });
  },
  ['GET']
);
