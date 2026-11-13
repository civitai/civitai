import * as z from 'zod';
import { listGiftClaims } from '~/server/services/model-version-gift.service';
import { giftClaimsQuery, GiftEndpoint, parseVersionId } from '~/server/utils/model-gift-endpoint';

export default GiftEndpoint(
  async (req, res, user) => {
    const modelVersionId = parseVersionId(req);
    const batchId = z.uuid().safeParse(req.query.batchId);
    const query = giftClaimsQuery.safeParse(req.query);
    if (!modelVersionId || !batchId.success || !query.success)
      return res.status(400).json({ error: 'Invalid request' });
    return res.status(200).json(
      await listGiftClaims({
        userId: user.id,
        isModerator: user.isModerator,
        modelVersionId,
        batchId: batchId.data,
        ...query.data,
      })
    );
  },
  ['GET']
);
