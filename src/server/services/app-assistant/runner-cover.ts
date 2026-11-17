import type { NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import type * as z from 'zod';
import type { CoverListingApi } from '@civitai/app-assistant';
import { getRunnerDevTunnelUser } from '~/server/services/app-assistant/app-assistant.service';
import type { VerifiedRunGrant } from '~/server/services/app-assistant/assistant-runner-tokens';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';

/** The one read the runner reaches: the user's own listing for an app. */
type CoverListingRead = Pick<CoverListingApi, 'getMyListingForApp'>;

/**
 * `userId`'s own listing for an app, through the service `appListings.getMyListingForApp` calls
 * (as `runner-app-feedback.ts` reads through `listMyAppListings`). Same gate as that procedure:
 * the service takes a user id and nothing else, so there is no moderator override to have, and it
 * admits only the listing's owner or an accepted editor seat (`resolveListingRole`). Someone else's
 * listing (`NOT_OWNED`) and none (`NOT_FOUND`) both answer NOT_FOUND, which `readCoverListing`
 * reads as no listing: one answer, so the runner learns nothing about listings it may not see.
 * Not the procedure's 60/60 rate limit: this sits behind the runner's secret and the run grant.
 */
export function runnerCoverListingRead(userId: number): CoverListingRead {
  return {
    async getMyListingForApp({ slug }) {
      const { OffsiteRequestError, getMyListingForApp } = await import(
        '~/server/services/blocks/offsite-listing.service'
      );
      try {
        return await getMyListingForApp({ slug, userId });
      } catch (err) {
        if (
          err instanceof OffsiteRequestError &&
          (err.code === 'NOT_FOUND' || err.code === 'NOT_OWNED')
        )
          throw new TRPCError({ code: 'NOT_FOUND', message: 'No listing of yours for this app' });
        throw err;
      }
    },
  };
}

/**
 * The front door of `/api/internal/app-assistant/cover/listing`: `readRunnerRequest`'s checks, then a
 * preview grant refused (it opens one live preview, nothing else), then the user the grant names
 * re-judged now (the App Assistant gates the runner's mint checks, and the App Blocks author
 * capability `appDeveloperProcedure` requires). Writes each refusal to `res` and returns null.
 */
export async function openRunnerCover<S extends z.ZodType<{ grant: string }>>(
  req: NextApiRequest,
  res: NextApiResponse,
  schema: S,
  badBody: string
): Promise<{ grant: VerifiedRunGrant; body: z.infer<S>; api: CoverListingRead } | null> {
  const request = await readRunnerRequest(req, res, schema, badBody);
  if (!request) return null;
  const { grant } = request;
  if (grant.use === 'preview') {
    res.status(403).json({ error: 'A preview grant cannot make a cover', code: 'refused' });
    return null;
  }
  const subject = await getRunnerDevTunnelUser(grant.userId);
  if (subject.refusal) {
    res
      .status(subject.refusal.status)
      .json({ error: subject.refusal.error, code: subject.refusal.code });
    return null;
  }
  return { grant, body: request.body, api: runnerCoverListingRead(subject.user.id) };
}
