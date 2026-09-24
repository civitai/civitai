import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { resubscribePushInput } from '~/server/schema/notification.schema';
import {
  deletePushSubscription,
  upsertPushSubscription,
} from '~/server/services/notification.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

// Called by the service worker's `pushsubscriptionchange` handler — the one push writer that can't
// go through tRPC (no app context inside a SW). Same validation and service call as
// notification.subscribePush.
export default AuthedEndpoint(
  async (req: NextApiRequest, res: NextApiResponse, user: SessionUser) => {
    const parsed = resubscribePushInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });

    const { oldEndpoint, ...subscription } = parsed.data;
    await upsertPushSubscription({
      ...subscription,
      userId: user.id,
      userAgent: req.headers['user-agent'],
    });
    // Reap the endpoint the push service rotated away from. Scoped to this user by the service, so
    // it can only ever delete a row this session already owns. Guarded on inequality because a SW
    // that reports the same endpoint twice would otherwise delete the row just written.
    if (oldEndpoint && oldEndpoint !== subscription.endpoint)
      await deletePushSubscription({ endpoint: oldEndpoint, userId: user.id });
    return res.status(200).json({ ok: true });
  },
  ['POST']
);
