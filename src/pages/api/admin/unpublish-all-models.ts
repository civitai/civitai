import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod/v4';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbWrite } from '~/server/db/client';
import { unpublishModelById } from '~/server/services/model.service';
import { logToAxiom } from '~/server/logging/client';

const schema = z.object({
  userId: z.coerce.number(),
  customMessage: z.string().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const queryResults = schema.safeParse(req.query);
  if (!queryResults.success) {
    return res.status(400).json({
      error: `Invalid query parameters: ${JSON.stringify(
        queryResults.error.flatten().fieldErrors
      )}`,
    });
  }

  const { userId, customMessage } = queryResults.data;

  try {
    // Fetch all models for the user
    const models = await dbWrite.model.findMany({
      where: { userId },
      select: { id: true, name: true },
    });

    if (models.length === 0) {
      return res.status(404).json({ error: 'No models found for the specified user' });
    }

    // Unpublish each model
    const results = [];
    for (const model of models) {
      try {
        await unpublishModelById({
          id: model.id,
          reason: 'other', // The function expects a specific enum type
          customMessage: customMessage ?? 'User has requested models to be unpublished',
          meta: undefined,
          userId: userId, // User who owns the models
          isModerator: true,
        }).catch((error) => {
          logToAxiom({
            type: 'error',
            name: 'unpublish-all-models',
            message: error.message,
            error,
          });
        });

        results.push({
          id: model.id,
          name: model.name,
          status: 'unpublished',
        });
      } catch (error) {
        console.error(`Failed to unpublish model ${model.id}:`, error);
        results.push({
          id: model.id,
          name: model.name,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const successCount = results.filter((r) => r.status === 'unpublished').length;
    const errorCount = results.filter((r) => r.status === 'error').length;

    return res.status(200).json({
      message: `Processed ${models.length} models for user ${userId}`,
      summary: {
        total: models.length,
        unpublished: successCount,
        errors: errorCount,
      },
      results,
    });
  } catch (error) {
    console.error('Error unpublishing models:', error);
    return res.status(500).json({
      error: 'Failed to unpublish models',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
