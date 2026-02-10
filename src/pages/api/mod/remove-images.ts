import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { handleBlockImages } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';
import { Limiter } from '~/server/utils/concurrency-helpers';

const schema = z.object({
  imageIds: z.array(z.number()).optional(),
  userId: z.number().optional(),
  moderatorId: z.number().optional(),
  reason: z.string().optional(),
  violationType: z.string().optional(),
  violationDetails: z.string().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    const { imageIds, userId, reason, moderatorId, violationType, violationDetails } = schema.parse(req.body);

    const tracker = new Tracker(req, res);
    const images = await handleBlockImages({ ids: imageIds, userId, moderatorId });
    await Limiter({ batchSize: 10000 }).process(images, async (images) => {
      await tracker.images(
        images.map((image) => ({
          type: 'DeleteTOS',
          imageId: image.id,
          ownerId: image.userId,
          nsfw: getNsfwLevelDeprecatedReverseMapping(image.nsfwLevel),
          tags: [],
          resources: [],
          tosReason: reason,
          violationType: violationType,
          violationDetails: violationDetails ?? '',
          userId: moderatorId,
        }))
      );
    });
    res.status(200).json({ images: images.length });
  } catch (e) {
    const err = e as Error;
    logToAxiom({
      type: 'mod-remove-images-error',
      error: err.message,
      cause: err.cause,
      stack: err.stack,
    });
    res.status(500);
  }
});
