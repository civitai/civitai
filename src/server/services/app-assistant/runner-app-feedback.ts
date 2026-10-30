import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  FEEDBACK_FILTERS,
  USER_FEEDBACK_DEFAULT_LIMIT,
  USER_FEEDBACK_MAX_LIMIT,
  createAppFeedbackSource,
  type AppFeedbackSource,
} from '@civitai/app-assistant';
import { logToAxiom, safeError } from '~/server/logging/client';
import { getRunnerDevTunnelUser } from '~/server/services/app-assistant/app-assistant.service';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';
import { listMyAppListings } from '~/server/services/blocks/app-access.service';
import { listAppFeedbackForListing } from '~/server/services/blocks/app-feedback.service';
import { listListingHistory } from '~/server/services/blocks/app-listing-history.service';

/**
 * The open app's feedback as `userId` may read it, through the SAME author reads My apps and the
 * listing editor use: `listMyAppListings` (owned ∪ accepted seats) finds the app by its key, then
 * `listListingHistory` (the review history) and `listAppFeedbackForListing` (the user-feedback
 * inbox, owner and editor only) read it, each re-checking the caller's role on the listing.
 */
export function appFeedbackSourceFor(userId: number): AppFeedbackSource {
  return createAppFeedbackSource({
    listMine: () => listMyAppListings({ userId }),
    listingHistory: (appListingId) => listListingHistory({ appListingId, userId }),
    listFeedback: (input) => listAppFeedbackForListing({ userId, input }),
  });
}

const grant = z.string().min(1).max(4096);
const app = z.string().min(1).max(200);
const reviewBody = z.object({ grant, app });
const userBody = z.object({
  grant,
  app,
  status: z.enum(FEEDBACK_FILTERS).default('new'),
  limit: z.number().int().min(1).max(USER_FEEDBACK_MAX_LIMIT).default(USER_FEEDBACK_DEFAULT_LIMIT),
  cursor: z.number().int().positive().optional(),
});

export const APP_FEEDBACK_NOT_FOUND = 'No listing of yours for this app';

/**
 * The handler of `/api/internal/app-assistant/app-feedback/{review,user}`: App Assistant's server
 * runner reads the open app's moderator review, or its users' feedback, FOR the user its run grant
 * names. See either route's header for the contract.
 */
export function runnerAppFeedbackRoute(kind: 'review' | 'user') {
  return async (req: AxiomAPIRequest, res: NextApiResponse) => {
    const request =
      kind === 'review'
        ? await readRunnerRequest(req, res, reviewBody, 'Expected { grant, app }')
        : await readRunnerRequest(
            req,
            res,
            userBody,
            'Expected { grant, app, status?, limit?, cursor? }'
          );
    if (!request) return;
    const { grant: verified, body } = request;
    const log = (type: string, extra: Record<string, unknown> = {}) =>
      logToAxiom({
        type: `app-assistant.runner-app-feedback.${kind}-${type}`,
        message: `App Assistant runner app feedback ${kind} ${type} for user ${verified.userId}`,
        userId: verified.userId,
        app: body.app,
        grantId: verified.grantId,
        ...extra,
      }).catch(() => undefined);

    try {
      // Every gate the runner's token mint checks, then the App Blocks author capability that My
      // apps' reads (`appDeveloperProcedure`) require.
      const subject = await getRunnerDevTunnelUser(verified.userId);
      if (subject.refusal) {
        if (subject.refusal.code !== 'unavailable')
          log('refused', { reason: subject.refusal.error });
        return res
          .status(subject.refusal.status)
          .json({ error: subject.refusal.error, code: subject.refusal.code });
      }
      const source = appFeedbackSourceFor(verified.userId);
      let answer: unknown;
      try {
        answer =
          'status' in body
            ? await source.userFeedback(body.app, {
                status: body.status,
                limit: body.limit,
                ...(body.cursor !== undefined ? { cursor: body.cursor } : {}),
              })
            : await source.review(body.app);
      } catch (err) {
        // A role lost between the list and the read: the same answer as no listing at all.
        if (err instanceof TRPCError && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND'))
          answer = null;
        else throw err;
      }
      // One answer for an app with no listing and an app of someone else's: no oracle.
      if (answer === null)
        return res.status(404).json({ error: APP_FEEDBACK_NOT_FOUND, code: 'NOT_FOUND' });
      return res.json(answer);
    } catch (err) {
      log('failed', { error: safeError(err) });
      return res
        .status(503)
        .json({ error: 'Could not read the app’s feedback right now', code: 'unavailable' });
    }
  };
}
