import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { getRunnerDevTunnelUser } from '~/server/services/app-assistant/app-assistant.service';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';
import { getDevTunnelFlagRefusal } from '~/server/services/blocks/dev-tunnel-access.service';
import {
  DEV_TUNNEL_IDLE_SECONDS,
  keepAliveDevTunnel,
  keepAliveDevTunnelAtHost,
} from '~/server/services/blocks/dev-tunnel.service';

/**
 * POST /api/internal/app-assistant/dev-tunnel/keepalive
 *
 * App Assistant's server runner keeps the user's dev tunnel for an app from idling out while a run
 * is in progress: the one the run opened (`start`, a sibling of this file), or the one the app's
 * sandbox is connected to though the run did not open it (the page's Restart preview, an earlier
 * reply), which the runner holds no id of. A tunnel no browser visits is reaped DEV_TUNNEL_IDLE_SECONDS
 * (30 min) after its last activity; this records activity, as a browser visit does. It never extends
 * the 8 h hard cap. Call it well inside the idle window (every few minutes) while the run lives, and
 * stop calling when it ends: the normal idle expiry then runs from the last call.
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body, one of:
 *   { grant, sessionId }   `sessionId` as `start` returned it
 *   { grant, host }        the grant's user's tunnel at `host` (the host the sandbox is connected
 *                          to), whoever opened it
 *
 * Re-judged on every call, for the grant's user: the App Assistant gates, the author capability and
 * the `app-blocks-dev-tunnel` kill switch, as `start` — so turning any of them off stops keeping
 * tunnels alive at the next call, and they idle out. The session must be the grant's user's own.
 *
 *   200 `{ sessionId | host, idleExpiresAt, expiresAt }` (as asked) unix seconds: when it idles out absent another
 *       call, and its hard cap
 *   400 `{ error }` the body is not that shape
 *   401 `{ error }` the runner's secret is missing or wrong; `invalid_grant` not a current run grant
 *   403 `refused` an App Assistant gate refuses the user; `FORBIDDEN` no author capability, or the
 *       dev-tunnel flag is off for them
 *   404 `NOT_FOUND` no such tunnel, it is not the grant's user's, or it is past its hard cap (one
 *       answer for all three)
 *   503 not configured; `unavailable` could not be judged or recorded just now: retry
 */
const grantField = z.string().min(1).max(4096);
const body = z.union([
  z.object({ grant: grantField, sessionId: z.string().min(1).max(128) }),
  z.object({ grant: grantField, host: z.string().min(1).max(253) }),
]);

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  const request = await readRunnerRequest(
    req,
    res,
    body,
    'Expected { grant, sessionId } or { grant, host }'
  );
  if (!request) return;
  const { grant } = request;
  const target: { sessionId: string } | { host: string } =
    'sessionId' in request.body
      ? { sessionId: request.body.sessionId }
      : { host: request.body.host };
  const log = (type: string, extra: Record<string, unknown> = {}) =>
    logToAxiom({
      type: `app-assistant.runner-dev-tunnel.keepalive-${type}`,
      message: `App Assistant runner dev tunnel keep-alive ${type} for user ${grant.userId}`,
      userId: grant.userId,
      ...target,
      grantId: grant.grantId,
      ...extra,
    }).catch(() => undefined);

  try {
    const subject = await getRunnerDevTunnelUser(grant.userId);
    if (subject.refusal) {
      if (subject.refusal.code !== 'unavailable') log('refused', { reason: subject.refusal.error });
      return res
        .status(subject.refusal.status)
        .json({ error: subject.refusal.error, code: subject.refusal.code });
    }
    const flagRefusal = await getDevTunnelFlagRefusal(subject.user);
    if (flagRefusal) {
      log('refused', { reason: flagRefusal.code });
      return res.status(403).json({ error: flagRefusal.error, code: flagRefusal.code });
    }

    // Both are looked up for the grant's user only: never another author's tunnel.
    const kept =
      'sessionId' in target
        ? await keepAliveDevTunnel(grant.userId, target.sessionId)
        : await keepAliveDevTunnelAtHost(grant.userId, target.host);
    if (kept.status === 'not_found')
      return res.status(404).json({ error: 'No such dev tunnel', code: 'NOT_FOUND' });
    if (kept.status === 'unavailable')
      return res
        .status(503)
        .json({ error: 'Could not keep the dev tunnel alive right now', code: 'unavailable' });
    return res.json({
      ...target,
      idleExpiresAt: kept.lastActivityAt + DEV_TUNNEL_IDLE_SECONDS,
      expiresAt: kept.hardExpiresAt,
    });
  } catch (err) {
    log('failed', { error: safeError(err) });
    return res
      .status(503)
      .json({ error: 'Could not keep the dev tunnel alive right now', code: 'unavailable' });
  }
});
