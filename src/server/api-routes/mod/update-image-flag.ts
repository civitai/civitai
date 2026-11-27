import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { updateImagesFlag } from '~/server/services/image.service';
import {
  assertMayLoosenImages,
  forwardedCsamGrantInQuery,
} from '~/server/services/moderator-withheld.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

const stringToNumberArraySchema = z.string().transform((s) => s.split(',').map(Number));

const schema = z.object({
  ids: stringToNumberArraySchema,
  flag: z.enum(['poi', 'minor']),
  value: booleanString(),
  csamReview: forwardedCsamGrantInQuery,
});

export default WebhookEndpoint(async function updateImageFlag(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    const { flag, ids, value, csamReview } = schema.parse(req.query);
    // Clearing a flag loosens the image; setting one does not.
    if (!value) await assertMayLoosenImages(ids, { csamReview });
    await updateImagesFlag({ ids, flag, value });
    res.status(200).json({
      message: `Updated ${ids.length} images with flag ${flag} to ${value}`,
    });
  } catch (e) {
    if (e instanceof TRPCError && e.code === 'FORBIDDEN')
      return res.status(403).json({ error: e.message });
    console.error(e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
