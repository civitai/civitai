import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { devTunnelStartFields } from '~/server/schema/blocks/dev-tunnel.schema';
import { getRunnerDevTunnelUser } from '~/server/services/app-assistant/app-assistant.service';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';
import {
  authorizeDevTunnelStart,
  claimDevTunnelStart,
  DEV_TUNNEL_REFUSAL_STATUS,
} from '~/server/services/blocks/dev-tunnel-access.service';
import { openDirectPreviewSession } from '~/server/services/blocks/dev-tunnel.service';
import {
  getDirectPreviewConfigFor,
  mintPreviewSessionHost,
} from '~/server/services/blocks/direct-preview.service';
import { PREVIEW_ID_REGEX } from '~/server/services/blocks/preview-session-host';
import { withDistributedLock } from '~/server/utils/distributed-lock';

/**
 * POST /api/internal/app-assistant/preview/open
 *
 * App Assistant's server runner opens the live preview of an app for the user its run grant names.
 * With the `app-assistant-direct-preview` flag off for that user (or direct preview not configured
 * on this deployment) the answer is `{ mode: "tunnel" }`, writing nothing, and the runner starts a
 * dev tunnel as before (`dev-tunnel/start`). With it on, the preview is served by the sandbox
 * service's preview gateway: civitai writes the same dev-tunnel session record a tunnel start
 * writes (scopes, declared auth, Buzz cap, idle and reap), with `transport: "direct"` and a session
 * host it mints for the Sandbox's preview id, and there is no tunnel, route or DNS record.
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body:
 *   { grant, blockId, previewId, declaredScopes?, declaredAuth? }
 * `previewId` is the Sandbox's current preview id (32 lowercase hex), as the sandbox service
 * reports it.
 *
 * Gates are re-judged on every call as `dev-tunnel/start` judges them: `getRunnerDevTunnelUser`
 * (which reads the user from the primary, so a ban is seen at once), then
 * `authorizeDevTunnelStart`. Reuse, write or `fresh`: see `openDirectPreviewSession`.
 *
 * `{ mode: "direct", fresh: true }`: the id had a session that has ended; nothing was written.
 * Rotate the Sandbox's preview id and call again, once; a second `fresh` is an error, not a
 * reason to loop.
 *
 *   200 `{ mode: "tunnel" }`, `{ mode: "direct", sessionId }`, or `{ mode: "direct", fresh: true }`.
 *       No session host: it is the session's credential, and the page gets the frame by block id.
 *   400 `{ error }` the body is not that shape
 *   401 `{ error }` the runner's secret is missing or wrong; `invalid_grant` not a current run grant
 *   403 `refused` an App Assistant gate refuses the user; `FORBIDDEN` no author capability, or the
 *       dev-tunnel flag is off for them
 *   404 `NOT_FOUND` the user does not own `blockId` (the same answer for a missing app)
 *   429 `TOO_MANY_REQUESTS` too many unsubmitted-app starts this hour
 *   503 not configured; `unavailable` could not be judged or written just now, or another open of
 *       the same app is in progress: retry
 *
 * Keep it open with `dev-tunnel/keepalive { blockId }`, and close it with
 * `dev-tunnel/stop { blockId }`; a direct session idles out and is capped at 8 h like a tunnel.
 */
const body = z.object({
  grant: z.string().min(1).max(4096),
  blockId: devTunnelStartFields.blockId,
  previewId: z.string().regex(PREVIEW_ID_REGEX),
  declaredScopes: devTunnelStartFields.declaredScopes,
  declaredAuth: devTunnelStartFields.declaredAuth,
});

const UNAVAILABLE = { error: 'Could not open the preview right now', code: 'unavailable' };

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  const request = await readRunnerRequest(
    req,
    res,
    body,
    'Expected { grant, blockId, previewId, declaredScopes?, declaredAuth? }'
  );
  if (!request) return;
  const { grant } = request;
  const { blockId, previewId, declaredScopes, declaredAuth } = request.body;

  try {
    const subject = await getRunnerDevTunnelUser(grant.userId);
    if (subject.refusal)
      return res
        .status(subject.refusal.status)
        .json({ error: subject.refusal.error, code: subject.refusal.code });

    const config = await getDirectPreviewConfigFor(subject.user);
    if (!config) return res.json({ mode: 'tunnel' });

    const gate = await authorizeDevTunnelStart(subject.user, blockId, { countStart: false });
    if (!gate.ok)
      return res
        .status(DEV_TUNNEL_REFUSAL_STATUS[gate.refusal.code])
        .json({ error: gate.refusal.error, code: gate.refusal.code });

    // One open per (user, app) at a time: a second one would replace the first's session.
    const opened = await withDistributedLock(
      {
        key: `app-assistant-preview-open:${grant.userId}:${gate.blockId}`,
        ttl: 30,
        autoRenew: true,
      },
      () =>
        openDirectPreviewSession({
          userId: grant.userId,
          blockId: gate.blockId,
          previewId,
          declaredScopes,
          ...(declaredAuth ? { declaredAuth } : {}),
          claimStart: () => claimDevTunnelStart(grant.userId, gate.ephemeral),
          mintHost: (fields) => mintPreviewSessionHost(config, fields),
        })
    );
    if (!opened) return res.status(503).json(UNAVAILABLE);
    if (opened.kind === 'fresh') return res.json({ mode: 'direct', fresh: true });
    if (opened.kind === 'refused')
      return res
        .status(DEV_TUNNEL_REFUSAL_STATUS[opened.refusal.code])
        .json({ error: opened.refusal.error, code: opened.refusal.code });
    if (opened.kind === 'written')
      logToAxiom({
        type: 'app-assistant.runner-preview.opened',
        message: `App Assistant runner direct preview opened for user ${grant.userId}`,
        userId: grant.userId,
        blockId: gate.blockId,
        sessionId: opened.session.sessionId,
        grantId: grant.grantId,
      });
    return res.json({ mode: 'direct', sessionId: opened.session.sessionId });
  } catch (err) {
    logToAxiom({
      type: 'app-assistant.runner-preview.failed',
      message: `App Assistant runner direct preview failed for user ${grant.userId}`,
      userId: grant.userId,
      blockId,
      grantId: grant.grantId,
      payload: { error: safeError(err) },
    });
    return res.status(503).json(UNAVAILABLE);
  }
});
