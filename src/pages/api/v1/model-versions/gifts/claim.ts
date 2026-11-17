import * as z from 'zod';
import { claimGiftSchema } from '~/server/schema/model-version-gift.schema';
import { claimGift } from '~/server/services/model-version-gift.service';
import { GiftEndpoint } from '~/server/utils/model-gift-endpoint';

export default GiftEndpoint(
  async (req, res, user) => {
    const parsed = claimGiftSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
    return res.status(200).json(await claimGift({ user, code: parsed.data.code }));
  },
  ['POST']
);
