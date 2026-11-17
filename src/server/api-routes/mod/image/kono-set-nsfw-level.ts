import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { NsfwLevel } from '~/server/common/enums';
import { setImageNsfwLevelFromKnights } from '~/server/services/image.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// Blocked is a moderator's call: a player consensus can raise or lower a rating, never block.
const VOTABLE_LEVELS: number[] = [
  NsfwLevel.PG,
  NsfwLevel.PG13,
  NsfwLevel.R,
  NsfwLevel.X,
  NsfwLevel.XXX,
];

const schema = z.object({
  imageId: z.coerce.number().int().positive(),
  nsfwLevel: z.coerce.number().refine((level) => VOTABLE_LEVELS.includes(level)),
  userId: z.coerce.number().int().positive(),
});

// Records `setNsfwLevelKono`, not `setNsfwLevel`, so a player vote is not counted as a moderator ruling
// (see NON_MODERATOR_ACTIVITIES in moderation-board.service.ts). `userId` is the player whose vote completed the consensus.
// A refusal is a 200 { outcome: 'skipped' }, not an error: the caller treats skipped as final and only a throw as retryable.
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
  const { imageId, nsfwLevel, userId } = parsed.data;

  const result = await setImageNsfwLevelFromKnights({ id: imageId, nsfwLevel, userId });
  if (!result.applied) {
    return res.status(200).json({
      imageId,
      outcome: 'skipped',
      reason: result.reason,
      currentLevel: result.currentLevel,
    });
  }
  return res.status(200).json({ imageId, outcome: 'applied', nsfwLevel });
});
