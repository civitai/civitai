import type { NextApiRequest, NextApiResponse } from 'next';
import { notifications } from '~/server/notifications/client';
import { bareNotification } from '~/server/notifications/base.notifications';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import type { SessionUser } from '~/types/session';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';

const schema = bareNotification;

/**
 * How far back to look for the notification the caller named. The only caller is the signal handler
 * enriching a notification that has just arrived, so it is the newest row for that user — the window
 * exists to tolerate a burst landing in the same instant, not to search history.
 */
const RECENT = 50;

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    const results = schema.safeParse(req.body);
    if (!results.success) {
      return res.status(400).json({ error: `Could not parse notification data` });
    }

    try {
      // 🔴 The REQUEST BODY is not evidence of anything. The detail fetchers key on ids inside
      // `details` and return the entity's content — a comment body and its author, a review's text —
      // so trusting the posted payload let any authenticated caller read content by id, including from
      // threads they cannot open (an unpublished model's, a cohort-gated app listing's). The client
      // posts a notification it received over the signal; we look that notification up as the caller's
      // own and enrich the STORED row, so an id the caller was never sent enriches nothing.
      const own = await notifications.queryNotifications({ userId: user.id, limit: RECENT });
      const stored = own.find((n) => n.id === results.data.id);
      if (!stored) return res.status(404).json({ error: 'Notification not found' });

      const notification = { id: stored.id, type: stored.type, details: stored.details };
      await populateNotificationDetails([notification]);
      return res.json(notification);
    } catch (error) {
      // civitai#3845 (population B): `populateNotificationDetails` fans out over
      // per-type detail fetchers that query the DB directly, so the whole error
      // OBJECT serialized here was driver-derived.
      return handleEndpointError(res, error);
    }
  },
  ['POST']
);
