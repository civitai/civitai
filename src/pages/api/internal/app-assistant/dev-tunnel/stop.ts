import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';
import { stopDevTunnel } from '~/server/services/blocks/dev-tunnel.service';

/**
 * POST /api/internal/app-assistant/dev-tunnel/stop
 *
 * App Assistant's server runner closes a dev tunnel it opened (`start`, a sibling of this file):
 * the route, the host and the credential go, as `blocks.stopDevTunnel` does it. Idempotent.
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body:
 *   { grant, sessionId }   `sessionId` as `start` returned it
 *
 * Only the grant's user's own tunnel is closed (`stopDevTunnel` checks the owner). Unlike `start`
 * and `keepalive`, no feature gate is re-judged: closing only ever takes access away, and a user a
 * gate now refuses is exactly one whose tunnel should close.
 *
 *   200 `{ stopped }` true when a tunnel of the grant's user's was closed; false when there was
 *       none (already gone, or not theirs)
 *   400 `{ error }` the body is not that shape
 *   401 `{ error }` the runner's secret is missing or wrong; `invalid_grant` not a current run grant
 *   503 not configured; `unavailable` could not be closed just now: retry
 */
const body = z.object({
  grant: z.string().min(1).max(4096),
  sessionId: z.string().min(1).max(128),
});

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  const request = await readRunnerRequest(req, res, body, 'Expected { grant, sessionId }');
  if (!request) return;
  const { grant } = request;
  const { sessionId } = request.body;
  const log = (type: string, extra: Record<string, unknown> = {}) =>
    logToAxiom({
      type: `app-assistant.runner-dev-tunnel.${type}`,
      message: `App Assistant runner dev tunnel ${type} for user ${grant.userId}`,
      userId: grant.userId,
      sessionId,
      grantId: grant.grantId,
      ...extra,
    }).catch(() => undefined);

  try {
    const stopped = await stopDevTunnel(grant.userId, sessionId);
    if (stopped) log('stopped');
    return res.json({ stopped });
  } catch (err) {
    log('stop-failed', { error: safeError(err) });
    return res
      .status(503)
      .json({ error: 'Could not close the dev tunnel right now', code: 'unavailable' });
  }
});
