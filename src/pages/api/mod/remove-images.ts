import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { handleBlockImages } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getNsfwLevelDeprecatedReverseMapping } from '~/shared/constants/browsingLevel.constants';
import { Limiter } from '~/server/utils/concurrency-helpers';
import { ViolationType } from '~/server/common/enums';

const schema = z.object({
  imageIds: z.array(z.number()).optional(),
  userId: z.number().optional(),
  moderatorId: z.number().optional(),
  reason: z.string().optional(),
  violationType: z.enum(ViolationType).optional(),
  violationDetails: z.string().trim().min(1).optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });

  try {
    const { imageIds, userId, reason, moderatorId, violationType, violationDetails } = parsed.data;

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
    res
      .status(500)
      .json({ error: 'Removal may be incomplete; reload to see which images are blocked' });
  }
});
