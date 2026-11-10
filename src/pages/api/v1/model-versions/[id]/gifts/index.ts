import * as z from 'zod';
import { mintGiftCodesSchema } from '~/server/schema/model-version-gift.schema';
import { listGiftLinks, mintGiftCodes } from '~/server/services/model-version-gift.service';
import { GiftEndpoint, parseVersionId } from '~/server/utils/model-gift-endpoint';

export default GiftEndpoint(
  async (req, res, user) => {
    const modelVersionId = parseVersionId(req);
    if (!modelVersionId) return res.status(400).json({ error: 'Invalid model version id' });
    const actor = { userId: user.id, isModerator: user.isModerator, modelVersionId };

    if (req.method === 'GET') return res.status(200).json(await listGiftLinks(actor));

    const parsed = mintGiftCodesSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
    return res
      .status(201)
      .json(await mintGiftCodes({ userId: user.id, modelVersionId, ...parsed.data }));
  },
  ['GET', 'POST']
);
