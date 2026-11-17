import { revokeGiftLinks } from '~/server/services/model-version-gift.service';
import { GiftEndpoint, parseVersionId } from '~/server/utils/model-gift-endpoint';

export default GiftEndpoint(
  async (req, res, user) => {
    const modelVersionId = parseVersionId(req);
    const id = Number(req.query.giftId);
    if (!modelVersionId || !Number.isInteger(id) || id < 1)
      return res.status(400).json({ error: 'Invalid id' });
    return res.status(200).json(
      await revokeGiftLinks({
        userId: user.id,
        isModerator: user.isModerator,
        modelVersionId,
        id,
      })
    );
  },
  ['DELETE']
);
