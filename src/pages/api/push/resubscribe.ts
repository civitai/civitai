import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { upsertPushSubscriptionInput } from '~/server/schema/notification.schema';
import { upsertPushSubscription } from '~/server/services/notification.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

// Called by the service worker's `pushsubscriptionchange` handler — the one push writer that can't
// go through tRPC (no app context inside a SW). Same validation and service call as
// notification.subscribePush.
export default AuthedEndpoint(
  async (req: NextApiRequest, res: NextApiResponse, user: SessionUser) => {
    const parsed = upsertPushSubscriptionInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

    await upsertPushSubscription({
      ...parsed.data,
      userId: user.id,
      userAgent: req.headers['user-agent'],
    });
    return res.status(200).json({ ok: true });
  },
  ['POST']
);
