import * as z from 'zod/v4';
import { chunk } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

const schema = z.object({
  batchSize: z.coerce.number().default(1000),
  dryRun: booleanString().default(true),
});

type GallerySettings = {
  tags?: number[];
  level?: number;
  users?: number[];
  images?: number[];
  hiddenImages?: Record<string, number[]>;
  pinnedPosts?: Record<string, number[]>;
};

/**
 * Endpoint to run a script that will migrate the images field in a
 * model gallerySettings from a simple array to be an object with the
 * modelVersionId as key storing the image ids for each version
 */
export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({
      ok: false,
      message: 'Allowed methods: GET',
    });
  }

  const { batchSize, dryRun } = schema.parse(req.query);

  try {
    // Get all models that have images in gallerySettings but no hiddenImages field
    const modelsToMigrate = await dbWrite.$queryRaw<
      Array<{ id: number; name: string; gallerySettings: GallerySettings }>
    >`
      SELECT id, name, "gallerySettings"
      FROM "Model"
      WHERE "gallerySettings"->>'images' IS NOT NULL 
        AND jsonb_array_length("gallerySettings"->'images') > 0
        AND "gallerySettings"->>'hiddenImages' IS NULL
      ORDER BY id
    `;

    console.log(`Found ${modelsToMigrate.length} models to migrate`);

    if (modelsToMigrate.length === 0) {
      return res.json({
        ok: true,
        message: 'No models found that need migration',
        processed: 0,
      });
    }

    const batches = chunk(modelsToMigrate, batchSize);
    let totalProcessed = 0;
    let totalUpdated = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      console.log(`Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} models)`);

      for (const model of batch) {
        const { id: modelId, gallerySettings } = model;
        const imageIds = gallerySettings.images || [];

        if (imageIds.length === 0) {
          totalProcessed++;
          continue;
        }

        // Get the mapping of image IDs to model version IDs for this model
        const imageToVersionMapping = await dbWrite.$queryRaw<
          Array<{ imageId: number; modelVersionId: number }>
        >`
          SELECT DISTINCT irn."imageId", irn."modelVersionId"
          FROM "ImageResourceNew" irn
          JOIN "ModelVersion" mv ON irn."modelVersionId" = mv.id
          WHERE irn."imageId" = ANY(${imageIds})
            AND mv."modelId" = ${modelId}
          ORDER BY irn."modelVersionId", irn."imageId"
        `;

        // Group images by model version ID
        const hiddenImages: Record<string, number[]> = {};

        for (const mapping of imageToVersionMapping) {
          const versionId = mapping.modelVersionId.toString();
          if (!hiddenImages[versionId]) {
            hiddenImages[versionId] = [];
          }
          if (!hiddenImages[versionId].includes(mapping.imageId)) {
            hiddenImages[versionId].push(mapping.imageId);
          }
        }

        // Only update if we found mappings
        if (Object.keys(hiddenImages).length > 0) {
          const newGallerySettings = {
            ...gallerySettings,
            hiddenImages,
          };

          if (dryRun) {
            console.log(`[DRY RUN] Model ${modelId} (${model.name}):`);
            console.log(`  - Original images: [${imageIds.join(', ')}]`);
            console.log(`  - New hiddenImages:`, JSON.stringify(hiddenImages, null, 2));
          } else {
            await dbWrite.$executeRaw`
              UPDATE "Model"
              SET "gallerySettings" = ${JSON.stringify(newGallerySettings)}::jsonb
              WHERE id = ${modelId}
            `;

            // Clear Redis cache for this model's gallery settings
            await redis.del(`${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${modelId}`);
          }

          console.log(
            `${dryRun ? '[DRY RUN] ' : ''}Updated model ${modelId}: ${
              imageIds.length
            } images mapped to ${Object.keys(hiddenImages).length} versions`
          );
          totalUpdated++;
        } else {
          console.log(`Model ${modelId}: No version mappings found for ${imageIds.length} images`);
        }

        totalProcessed++;
      }

      // Add a small delay between batches to avoid overwhelming the database
      if (batchIndex < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return res.json({
      ok: true,
      message: dryRun ? 'Dry run completed successfully' : 'Migration completed successfully',
      totalModels: modelsToMigrate.length,
      processed: totalProcessed,
      updated: totalUpdated,
      dryRun,
    });
  } catch (error) {
    console.error('Migration error:', error);
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  }
});
