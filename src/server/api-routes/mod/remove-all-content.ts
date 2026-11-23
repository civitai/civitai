import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { Tracker } from '~/server/clickhouse/client';
import {
  LegalHoldError,
  LegalHoldStoppedError,
  legalHoldMessage,
  ProfileArchiveRefusedError,
  PURGE_ARCHIVE_REFUSAL,
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
  let keptModelIds: number[];
  try {
    ({ incomplete, keptModelIds } = await removeAllContent({
      id: userId,
      claimedModeratorId: moderatorId ?? null,
    }));
  } catch (e) {
    // A 503 the moderator app tells apart from a lost answer by its message: nothing was deleted.
    if (e instanceof ProfileArchiveRefusedError)
      return res.status(503).json({ message: PURGE_ARCHIVE_REFUSAL });
    if (!(e instanceof LegalHoldError)) throw e;
    // Part of the account was deleted, so it is recorded like a wipe that finished.
    const stopped = e instanceof LegalHoldStoppedError;
    if (stopped) track();
    if (stopped && e.incomplete.length)
      return res.status(409).json({ message: legalHoldMessage(e), incomplete: e.incomplete });
    return handleEndpointError(
      res,
      new TRPCError({ code: stopped ? 'CONFLICT' : 'FORBIDDEN', message: legalHoldMessage(e) })
    );
  }
  track();

  return res.status(200).json({
    userId,
    incomplete,
    keptModelIds,
  });
});
