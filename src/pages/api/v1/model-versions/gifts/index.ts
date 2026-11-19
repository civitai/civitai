import * as z from 'zod';
import { GIFT_INDEX_PAGE_MAX } from '~/server/services/model-version-gift.constants';
import { listMyGiftLinks } from '~/server/services/model-version-gift.service';
import { GiftEndpoint } from '~/server/utils/model-gift-endpoint';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(GIFT_INDEX_PAGE_MAX).default(GIFT_INDEX_PAGE_MAX),
  cursor: z.string().min(1).max(200).optional(),
  // Read the primary, for a page loaded right after a revoke.
  fresh: z
    .literal('1')
    .optional()
    .transform((v) => v === '1'),
});

export default GiftEndpoint(
  async (req, res, user) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
    return res.status(200).json(await listMyGiftLinks({ userId: user.id, ...parsed.data }));
  },
  ['GET']
);
