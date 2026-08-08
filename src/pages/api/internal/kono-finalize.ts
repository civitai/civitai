import * as z from 'zod';
import { NsfwLevel } from '~/server/common/enums';
import { isImageInQueue, updatePendingImageRatings } from '~/server/services/games/new-order.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

const schema = z.object({
  imageId: z.coerce.number().int().positive(),
  // Same validation as updateImageNsfwLevelSchema.nsfwLevel — types the value as NsfwLevel so it flows into
  // updatePendingImageRatings' `rating` param without a cast.
  nsfwLevel: z.enum(NsfwLevel),
});

// Internal callback so spoke apps (apps/moderator) that set an image's nsfwLevel directly in Postgres can
// still run the Knights-of-New-Order finalization they can't do themselves: finalize players' pending votes
// against the moderator's rating (ClickHouse buffer + processFinalRatings + smites + player counters), drop
// the image from the review pool, and — the load-bearing reason this can't move to the spoke — emit the
// real-time WebSocket player-stat signals. Mirrors the moderator branch of handleUpdateImageNsfwLevel
// (image.controller.ts): the spoke has ALREADY written the nsfwLevel, so this endpoint runs ONLY the
// game-engine side effects. Token-guarded via WEBHOOK_TOKEN (fully trusted internal caller).
export default WebhookEndpoint(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const result = schema.safeParse(req.body);
  if (!result.success)
    return res.status(400).json({ error: 'Invalid input', details: result.error.issues });

  const { imageId, nsfwLevel } = result.data;

  await updatePendingImageRatings({ imageId, rating: nsfwLevel });
  const valueInQueue = await isImageInQueue({
    imageId,
    rankType: [NewOrderRankType.Knight, NewOrderRankType.Templar, 'Inquisitor'],
  });
  if (valueInQueue) await valueInQueue.pool.reset({ id: imageId });

  return res.status(200).json({ ok: true, imageId });
});
