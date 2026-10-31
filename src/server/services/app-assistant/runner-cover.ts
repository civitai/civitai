import type { NextApiRequest, NextApiResponse } from 'next';
import { TRPCError } from '@trpc/server';
import type * as z from 'zod';
import type { CoverListingApi } from '@civitai/app-assistant';
import { getRunnerDevTunnelUser } from '~/server/services/app-assistant/app-assistant.service';
import type { VerifiedRunGrant } from '~/server/services/app-assistant/assistant-runner-tokens';
import { runnerCoverListingApi } from '~/server/services/app-assistant/runner-cover-caller';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';

/** An app key as the runner sends it (the page's own state, never trusted: looked up as the user). */
export const RUNNER_COVER_APP_MAX = 200;

/**
 * The front door of `/api/internal/app-assistant/cover/*`: `readRunnerRequest`'s checks, then a
 * preview grant refused (it opens one live preview, nothing else), then the user the grant names
 * re-judged now (the App Assistant gates the runner's mint checks, and the App Blocks author
 * capability `appDeveloperProcedure` requires). Writes each refusal to `res` and returns null.
 */
export async function openRunnerCover<S extends z.ZodType<{ grant: string }>>(
  req: NextApiRequest,
  res: NextApiResponse,
  schema: S,
  badBody: string
): Promise<{ grant: VerifiedRunGrant; body: z.infer<S>; api: CoverListingApi } | null> {
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
  return { grant, body: request.body, api: runnerCoverListingApi(req, res, subject.user) };
}

/**
 * Why civitai would not put the cover on the listing, in the user's words: a procedure's own refusal
 * (the cover check, the scan, a rate limit) as it says it; anything else, which can carry internal
 * detail, as a generic retry hint.
 */
export function coverRefusalMessage(error: unknown): string {
  if (error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR' && error.message)
    return error.message;
  return 'try again in a moment.';
}
