import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { permaDeleteModelById } from '~/server/services/model.service';
import { dbRead } from '~/server/db/client';
import { booleanString, commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z
  .object({
    ids: commaDelimitedNumberArray().optional(),
    userId: z.coerce.number().optional(),
    dryRun: booleanString().default(true),
  })
  .refine((data) => data.ids || data.userId, {
    message: "Either 'ids' or 'userId' must be provided",
  });

export default WebhookEndpoint(async function permaDeleteModels(req, res) {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    return res.status(400).json({ success: false, errors: z.flattenError(result.error) });
  }

  const { ids, userId, dryRun } = result.data;

  const whereClause = {
    poi: true,
    ...(ids ? { id: { in: ids } } : {}),
    ...(userId ? { userId } : {}),
  };

  const models = await dbRead.model.findMany({
    where: whereClause,
    select: { id: true },
  });

  if (models.length === 0) {
    const searchCriteria = ids ? `IDs: ${ids.join(', ')}` : `userId: ${userId as number}`;
    return res
      .status(404)
      .json({ success: false, message: `No POI models found for the provided ${searchCriteria}` });
  }

  const searchCriteria = ids ? `${ids.length} specific IDs` : `user ${userId as number}`;
  console.log(
    `${dryRun ? 'DRY RUN: ' : ''}Starting permanent deletion of ${
      models.length
    } POI models for ${searchCriteria}`
  );

  const results = {
    total: models.length,
    successful: 0,
    failed: 0,
    errors: [] as Array<{ modelId: number; error: string }>,
  };

  for (const model of models) {
    try {
      if (dryRun) {
        console.log(`✓ DRY RUN: Would delete POI model ${model.id}`);
      } else {
        await permaDeleteModelById({ id: model.id, userId: -1 });
        console.log(`✓ Successfully deleted POI model ${model.id}`);
      }
      results.successful++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      results.errors.push({ modelId: model.id, error: errorMessage });
      results.failed++;
      console.error(`✗ Failed to delete POI model ${model.id}:`, errorMessage);
    }
  }

  console.log(
    `${dryRun ? 'DRY RUN: ' : ''}Permanent deletion completed: ${results.successful} successful, ${
      results.failed
    } failed`
  );

  res.status(200).json({
    success: true,
    message: `${dryRun ? 'DRY RUN: ' : ''}Processed ${results.total} models`,
    dryRun,
    results,
  });
});
