import * as z from 'zod';
import { createGiftLinkSchema } from '~/server/schema/model-version-gift.schema';
import { createGiftLink } from '~/server/services/model-version-gift.service';
import { GiftEndpoint, parseVersionId } from '~/server/utils/model-gift-endpoint';

export default GiftEndpoint(
  async (req, res, user) => {
    const modelVersionId = parseVersionId(req);
    if (!modelVersionId) return res.status(400).json({ error: 'Invalid model version id' });
    const parsed = createGiftLinkSchema.safeParse({ ...req.body, modelVersionId });
    if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
    return res.status(201).json(await createGiftLink({ ...parsed.data, userId: user.id }));
  },
  ['POST']
);
