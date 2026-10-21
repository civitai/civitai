import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { Tracker } from '~/server/clickhouse/client';
import {
  LegalHoldError,
  LegalHoldStoppedError,
  legalHoldMessage,
} from '~/server/services/legal-hold.service';
import { removeAllContent } from '~/server/services/user.service';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
  /** Who the caller says ordered the wipe. Unverified: named on alerts, never stored as the actor. */
  moderatorId: z.coerce.number().int().positive().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId, moderatorId } = schema.parse(req.query);

  const track = () =>
    new Tracker(req, res).userActivity({
      type: 'RemoveContent',
      targetUserId: userId,
    });
  let incomplete: string[];
  try {
    ({ incomplete } = await removeAllContent({
      id: userId,
      claimedModeratorId: moderatorId ?? null,
    }));
  } catch (e) {
    if (!(e instanceof LegalHoldError)) throw e;
    // Part of the account was deleted, so it is recorded like a wipe that finished.
    const stopped = e instanceof LegalHoldStoppedError;
    if (stopped) track();
    return handleEndpointError(
      res,
      new TRPCError({ code: stopped ? 'CONFLICT' : 'FORBIDDEN', message: legalHoldMessage(e) })
    );
  }
  track();

  return res.status(200).json({
    userId,
    incomplete,
  });
});
