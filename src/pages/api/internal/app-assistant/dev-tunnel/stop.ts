import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';
import {
  cancelDevTunnelStart,
  stopOwnDevTunnel,
} from '~/server/services/blocks/dev-tunnel.service';

/**
 * POST /api/internal/app-assistant/dev-tunnel/stop
 *
 * App Assistant's server runner closes a dev tunnel it opened (`start`, a sibling of this file):
 * the route, the host and the credential go, as `blocks.stopDevTunnel` does it. Idempotent.
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body, one of:
 *   { grant, sessionId }   `sessionId` as `start` returned it
 *   { grant, clientKey }   the `clientKey` a `start` was sent with, for a start the runner gave up
 *                          on (it timed out, or its reply ended) and so has no `sessionId` of:
 *                          closes what that start opened, whether it is still running
 *                          (`cancelDevTunnelStart`), has finished, or never came
 *
 * Only the grant's user's own tunnel is closed (`stopOwnDevTunnel` checks the owner, as
 * `stopDevTunnel` does). Unlike `start` and `keepalive`, no feature gate is re-judged: closing only
 * ever takes access away, and a user a gate now refuses is exactly one whose tunnel should close.
 * Teardown itself is best-effort (as in `blocks.stopDevTunnel`): once the session is read, what
 * cannot be deleted is left to the reaper and the hard TTL.
 *
 *   200 `{ stopped }` true when a tunnel of the grant's user's was closed; false when there was
 *       none (already gone, or not theirs)
 *   400 `{ error }` the body is not that shape
 *   401 `{ error }` the runner's secret is missing or wrong; `invalid_grant` not a current run grant
 *   503 not configured; `unavailable` the session could not be read just now, so nothing was
 *       closed and it may still be live: retry
 */
const body = z.union([
  z.object({ grant: z.string().min(1).max(4096), sessionId: z.string().min(1).max(128) }),
  z.object({ grant: z.string().min(1).max(4096), clientKey: z.string().min(1).max(128) }),
]);

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  const request = await readRunnerRequest(
    req,
    res,
    body,
    'Expected { grant, sessionId } or { grant, clientKey }'
  );
  if (!request) return;
  const { grant } = request;
  const target = request.body;
  const log = (type: string, extra: Record<string, unknown> = {}) =>
    logToAxiom({
      type: `app-assistant.runner-dev-tunnel.${type}`,
      message: `App Assistant runner dev tunnel ${type} for user ${grant.userId}`,
      userId: grant.userId,
      ...('sessionId' in target
        ? { sessionId: target.sessionId }
        : { clientKey: target.clientKey }),
      grantId: grant.grantId,
      ...extra,
    }).catch(() => undefined);

  try {
    const outcome =
      'sessionId' in target
        ? await stopOwnDevTunnel(grant.userId, target.sessionId)
        : await cancelDevTunnelStart(grant.userId, target.clientKey);
    if (outcome === 'unavailable')
      return res
        .status(503)
        .json({ error: 'Could not close the dev tunnel right now', code: 'unavailable' });
    if (outcome === 'stopped') log('stopped');
    return res.json({ stopped: outcome === 'stopped' });
  } catch (err) {
    log('stop-failed', { error: safeError(err) });
    return res
      .status(503)
      .json({ error: 'Could not close the dev tunnel right now', code: 'unavailable' });
  }
});
