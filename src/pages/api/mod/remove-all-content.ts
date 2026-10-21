import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { Tracker } from '~/server/clickhouse/client';
import {
  HOLD_UNCONFIRMED,
  LEGAL_HOLD_REFUSAL,
  LEGAL_HOLD_STOPPED,
  LegalHoldError,
  LegalHoldStoppedError,
  LegalHoldUnconfirmedError,
} from '~/server/services/legal-hold.service';
import { removeAllContent } from '~/server/services/user.service';
import { handleEndpointError, WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId } = schema.parse(req.query);

  const track = () =>
    new Tracker(req, res).userActivity({
      type: 'RemoveContent',
      targetUserId: userId,
    });
  let incomplete: string[];
  try {
    ({ incomplete } = await removeAllContent({ id: userId }));
  } catch (e) {
    // Part of the account was deleted, so it is recorded like a wipe that finished.
    if (e instanceof LegalHoldStoppedError) {
      track();
      return handleEndpointError(
        res,
        new TRPCError({ code: 'CONFLICT', message: LEGAL_HOLD_STOPPED })
      );
    }
    if (e instanceof LegalHoldUnconfirmedError)
      return handleEndpointError(
        res,
        new TRPCError({ code: 'FORBIDDEN', message: HOLD_UNCONFIRMED })
      );
    if (e instanceof LegalHoldError)
      return handleEndpointError(
        res,
        new TRPCError({ code: 'FORBIDDEN', message: LEGAL_HOLD_REFUSAL })
      );
    throw e;
  }
  track();

  // The wipe is done; `incomplete` names the cleanup steps after it that failed and need a re-run.
  return res.status(200).json({
    userId,
    incomplete,
  });
});
