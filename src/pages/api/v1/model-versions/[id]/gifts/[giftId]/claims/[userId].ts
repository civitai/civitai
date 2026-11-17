import { removeGiftClaim } from '~/server/services/model-version-gift.service';
import { GiftEndpoint, parseVersionId } from '~/server/utils/model-gift-endpoint';

export default GiftEndpoint(
  async (req, res, user) => {
    const modelVersionId = parseVersionId(req);
    const giftLinkId = Number(req.query.giftId);
    const claimerId = Number(req.query.userId);
    if (!modelVersionId || ![giftLinkId, claimerId].every((n) => Number.isInteger(n) && n > 0))
      return res.status(400).json({ error: 'Invalid request' });
    return res.status(200).json(
      await removeGiftClaim({
        userId: user.id,
        isModerator: user.isModerator,
        modelVersionId,
        giftLinkId,
        claimerId,
      })
    );
  },
  ['DELETE']
);
