import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { Prisma, TagSource } from '@prisma/client';
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
      FROM "TagsOnImage" toi
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
      await dbWrite.$executeRaw`
        WITH image_tags AS (
          SELECT
            (value ->> 'imageId')::int AS id,
            value ->> 'tag' AS tag
          FROM json_array_elements(${json}::json)
        )
        INSERT INTO "TagsOnImage" ("imageId", "tagId", "automated", "confidence", "source")
        SELECT
          it.id "imageId",
          t.id "tagId",
          true "automated",
          70 "confidence",
          'Computed' "source"
        FROM image_tags it
        JOIN "Tag" t ON t.name = it.tag
        ON CONFLICT ("imageId", "tagId") DO NOTHING;
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
