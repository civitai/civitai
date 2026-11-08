import { listGiftClaims } from '~/server/services/model-version-gift.service';
import { giftClaimsQuery, GiftEndpoint, parseVersionId } from '~/server/utils/model-gift-endpoint';

export default GiftEndpoint(
  async (req, res, user) => {
    const modelVersionId = parseVersionId(req);
    const id = Number(req.query.giftId);
    const query = giftClaimsQuery.safeParse(req.query);
    if (!modelVersionId || !Number.isInteger(id) || id < 1 || !query.success)
      return res.status(400).json({ error: 'Invalid request' });
    return res.status(200).json(
      await listGiftClaims({
        userId: user.id,
        isModerator: user.isModerator,
        modelVersionId,
        id,
        ...query.data,
      })
    );
  },
  ['GET']
);
