import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { updateImagesFlag } from '~/server/services/image.service';
import {
  assertMayLoosenImages,
  forwardedCsamGrantInQuery,
} from '~/server/services/moderator-withheld.service';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';
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
    const withheldFor = value ? undefined : { csamReview };
    if (withheldFor) await assertMayLoosenImages(ids, withheldFor);
    const written = await updateImagesFlag({ ids, flag, value, withheldFor });
    const updated = new Set(written);
    res.status(200).json({
      message: `Updated ${written.length} images with flag ${flag} to ${value}`,
      updated: written,
      skipped: ids.filter((id) => !updated.has(id)),
    });
  } catch (e) {
    if (e instanceof TRPCError && e.code === 'FORBIDDEN') return handleEndpointError(res, e);
    console.error(e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
