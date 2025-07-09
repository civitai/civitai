import { RewardsEligibility } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import { v4 as uuid } from 'uuid';
import * as z from 'zod/v4';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { userMultipliersCache } from '~/server/redis/caches';
import { trackModActivity } from '~/server/services/moderator.service';
import { createNotification } from '~/server/services/notification.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
  eligibility: z.nativeEnum(RewardsEligibility),
  modId: z.coerce.number(),
});

const eligibilityMessage: Record<RewardsEligibility, string> = {
  Eligible: 're-enabled',
  Ineligible: 'disabled due to suspicious activity',
  Protected: 're-enabled',
};

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, eligibility, modId } = schema.parse(req.body);

  await dbWrite.user.update({
    where: { id: userId },
    data: { rewardsEligibility: eligibility, eligibilityChangedAt: new Date() },
  });

  await userMultipliersCache.bust(userId);
  await createNotification({
    userId,
    category: NotificationCategory.System,
    type: 'system-announcement',
    key: `system-announcement:rewards:${uuid()}`,
    details: {
      message: `Your Buzz rewards have been ${eligibilityMessage[eligibility]}.`,
      url: '/user/buzz-dashboard',
    },
  });

  await trackModActivity(modId, {
    entityType: 'user',
    entityId: userId,
    activity: 'setRewardsEligibility',
  });

  return res.status(200).json({
    eligibility,
    userId,
  });
});
