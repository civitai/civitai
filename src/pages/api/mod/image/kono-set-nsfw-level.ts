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

// Called by the Knights of New Order app when player consensus settles an image's rating. It is the
// gate: the write happens only on an image that exists, has no block marker, and is unlocked or locked
// by an earlier Knights vote (see `setImageNsfwLevelFromKnights`). It records `setNsfwLevelKono`
// rather than `setNsfwLevel`, because a later job harvests `setNsfwLevel` rows as moderator rulings and
// a vote must stay distinguishable from one. `userId` is the player whose vote completed the consensus.
//
// Contract: a refusal is an answer, not an error, so every well-formed request gets a 200 with
//   { imageId, outcome: 'applied', nsfwLevel }
//   { imageId, outcome: 'skipped', reason: 'missing' | 'blocked' | 'locked', currentLevel }
// `currentLevel` is the image's level now (null when missing); for 'locked' it is the moderator's
// ruling. A malformed body is a 400. Anything else is a failure the caller may retry.
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
