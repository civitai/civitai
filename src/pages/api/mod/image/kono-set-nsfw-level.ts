import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { NsfwLevel } from '~/server/common/enums';
import { updateImageNsfwLevel } from '~/server/services/image.service';
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

// Called by the Knights of New Order app when player consensus settles an image's rating. Runs
// through the same service as a moderator ruling so caches and side effects fire, but records
// `setNsfwLevelKono`: a later job harvests `setNsfwLevel` rows as moderator rulings and a vote
// must stay distinguishable from one. `userId` is the player whose vote completed the consensus.
export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageId, nsfwLevel, userId } = schema.parse(req.body);

  await updateImageNsfwLevel({
    id: imageId,
    nsfwLevel,
    userId,
    // The only branch that sets the level and locks it directly; the other records a rating request.
    isModerator: true,
    activity: 'setNsfwLevelKono',
    status: 'Actioned',
  });

  return res.status(200).json({ imageId, nsfwLevel });
});
