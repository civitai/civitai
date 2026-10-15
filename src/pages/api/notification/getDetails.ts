import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { notifications } from '~/server/notifications/client';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import type { SessionUser } from '~/types/session';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';

/**
 * A notification id as it actually travels. The column is 64-bit, and the notifications service
 * serializes 64-bit integers as decimal STRINGS — in the signal the client forwards here and in the rows
 * `queryNotifications` returns alike — while every type along the way declares `number`. Requiring a
 * JSON number therefore refused every request a real client makes. Both spellings are accepted and
 * compared as numbers; anything else (empty, signed, fractional, beyond exact integer range) is not an
 * id.
 */
const notificationId = z
  .union([z.number(), z.string().regex(/^\d+$/)])
  .transform(Number)
  // `.int()` also refuses anything past Number.MAX_SAFE_INTEGER, where two ids could compare equal.
  .pipe(z.number().int().positive());

/**
 * Only the id is read. The client posts the whole notification it was signalled, but the rest of it is
 * a claim the handler never consults (see below), so validating it could only add ways to refuse a
 * well-formed caller.
 */
const schema = z.object({ id: notificationId });

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
      // Parsed the same way as the posted id: the stored id is a string at runtime too, so a strict
      // comparison of the two never matches.
      const stored = own.find((n) => notificationId.safeParse(n.id).data === results.data.id);
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
