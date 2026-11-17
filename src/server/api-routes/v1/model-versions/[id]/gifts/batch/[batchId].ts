import * as z from 'zod';
import { revokeGiftLinks } from '~/server/services/model-version-gift.service';
import { GiftEndpoint, parseVersionId } from '~/server/utils/model-gift-endpoint';

export default GiftEndpoint(
  async (req, res, user) => {
    const modelVersionId = parseVersionId(req);
    const batchId = z.uuid().safeParse(req.query.batchId);
    if (!modelVersionId || !batchId.success) return res.status(400).json({ error: 'Invalid id' });
    return res.status(200).json(
      await revokeGiftLinks({
        userId: user.id,
        isModerator: user.isModerator,
        modelVersionId,
        batchId: batchId.data,
      })
    );
  },
  ['DELETE']
);
