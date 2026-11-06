import { randomUUID } from 'node:crypto';
import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { devTunnelStartFields } from '~/server/schema/blocks/dev-tunnel.schema';
import { getRunnerDevTunnelUser } from '~/server/services/app-assistant/app-assistant.service';
import { readRunnerRequest } from '~/server/services/app-assistant/runner-request';
import { authorizeDevTunnelStart } from '~/server/services/blocks/dev-tunnel-access.service';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import {
  cancelDevTunnelStart,
  DEV_TUNNEL_START_CANCELLED,
  INVALID_SSH_PUBLIC_KEY,
  RUNNER_DEV_TUNNEL_START_DEADLINE_MS,
  startDevTunnel,
  stopDevTunnel,
} from '~/server/services/blocks/dev-tunnel.service';

/**
 * POST /api/internal/app-assistant/dev-tunnel/start
 *
 * App Assistant's server runner opens an App Blocks dev tunnel (the live preview) ON BEHALF OF the
 * user its run grant names. civitai opens it, with the same service `blocks.startDevTunnel` calls;
 * the runner never holds a credential that can start a tunnel, and no user credential reaches the
 * sandbox: the sandbox only ever gets the host, the sish host key to pin, and authorizes its OWN
 * single-use SSH key (which it generated, and whose public half the runner sends here), exactly as
 * in the browser's `start_preview`.
 *
 * Called only by the runner, with `Authorization: Bearer <ASSISTANT_RUNNER_SECRET>`. Body:
 *   { grant, blockId, sshPublicKey, declaredScopes?, declaredAuth?, clientKey? }
 * `blockId` to `declaredAuth` with `blocks.startDevTunnel`'s own bounds (`devTunnelStartSchema`).
 * `clientKey` is the runner's own key for this start: `stop` with it closes what this start opens,
 * even when the runner gave up before this answered (it timed out, or its reply ended).
 *
 * Re-judged on every call, for the grant's user as the database and Flipt have them now:
 *   1. the gates the runner's token mint checks (`getRunnerDevTunnelUser`): ban, onboarding, mute,
 *      email verification, `appBlocks` + `appAssistant`, `appAssistantRemoteRunner`;
 *   2. the App Blocks author capability (`appBlocksAuthor`, as `appDeveloperProcedure`);
 *   3. through `authorizeDevTunnelStart` — the function `blocks.startDevTunnel` itself calls — the
 *      `app-blocks-dev-tunnel` kill switch, ownership of `blockId`, and for an unsubmitted app the
 *      per-user hourly start limit (one counter shared with the browser path).
 * As in the browser path, starting a tunnel for a (user, app) pair that already has one replaces it.
 *
 *   200 `{ sessionId, host, sshHostPublicKey }`: dial `host` through sish, pinning `sshHostPublicKey`
 *   400 `{ error }` the body is not that shape; `BAD_REQUEST` the SSH public key does not parse
 *   401 `{ error }` the runner's secret is missing or wrong; `invalid_grant` not a current run grant
 *   403 `refused` an App Assistant gate refuses the user; `FORBIDDEN` no author capability, or the
 *       dev-tunnel flag is off for them
 *   404 `NOT_FOUND` the user does not own `blockId` (the same answer for a missing app: no oracle)
 *   409 `cancelled` the start was cancelled by its `clientKey` while it ran; nothing is left open
 *   429 `TOO_MANY_REQUESTS` too many unsubmitted-app starts this hour
 *   503 not configured (the runner's secret, or the sish host key, in which case nothing is left
 *       open); `unavailable` the gates could not be judged, or the tunnel could not be opened, just
 *       now, or not within `RUNNER_DEV_TUNNEL_START_DEADLINE_MS` (the start is then cancelled, so
 *       nothing it opens stays open): retry
 * Every error body is `{ error, code? }`. The codes 403/404/429/400 are the tRPC codes
 * `blocks.startDevTunnel` throws for the same refusals.
 *
 * Keep it open while a run is in progress with `keepalive`, and close it with `stop` (siblings of
 * this file); once keep-alives stop, the tunnel idles out after the browser-idle window and never
 * outlives the 8 h hard cap.
 */
const body = z.object({
  grant: z.string().min(1).max(4096),
  ...devTunnelStartFields,
  clientKey: z.string().min(1).max(128).optional(),
});

/** The HTTP status of each tRPC code `authorizeDevTunnelStart` refuses with. */
const REFUSAL_STATUS = { FORBIDDEN: 403, NOT_FOUND: 404, TOO_MANY_REQUESTS: 429 } as const;

type Answer = { status: number; json: Record<string, unknown> };
const UNAVAILABLE: Answer = {
  status: 503,
  json: { error: 'Could not open the dev tunnel right now', code: 'unavailable' },
};

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  const request = await readRunnerRequest(
    req,
    res,
    body,
    'Expected { grant, blockId, sshPublicKey, declaredScopes?, declaredAuth?, clientKey? }'
  );
  if (!request) return;
  const { grant } = request;
  const { blockId, sshPublicKey, declaredScopes, declaredAuth } = request.body;
  // A start the runner sent no key for still gets one: the deadline below cancels by it.
  const clientKey = request.body.clientKey ?? `civitai-${randomUUID()}`;
  const log = (type: string, extra: Record<string, unknown> = {}) =>
    logToAxiom({
      type: `app-assistant.runner-dev-tunnel.${type}`,
      message: `App Assistant runner dev tunnel ${type} for user ${grant.userId}`,
      userId: grant.userId,
      blockId,
      grantId: grant.grantId,
      conversationId: grant.conversationId,
      ...extra,
    }).catch(() => undefined);

  const open = async (): Promise<Answer> => {
    try {
      const subject = await getRunnerDevTunnelUser(grant.userId);
      if (subject.refusal) {
        if (subject.refusal.code !== 'unavailable')
          log('refused', { reason: subject.refusal.error });
        return {
          status: subject.refusal.status,
          json: { error: subject.refusal.error, code: subject.refusal.code },
        };
      }
      const gate = await authorizeDevTunnelStart(subject.user, blockId);
      if (!gate.ok) {
        log('refused', { reason: gate.refusal.code });
        return {
          status: REFUSAL_STATUS[gate.refusal.code],
          json: { error: gate.refusal.error, code: gate.refusal.code },
        };
      }

      let started: Awaited<ReturnType<typeof startDevTunnel>>;
      try {
        started = await startDevTunnel({
          userId: grant.userId,
          blockId: gate.blockId,
          sshPublicKey,
          declaredScopes,
          ...(declaredAuth ? { declaredAuth } : {}),
          clientKey,
        });
      } catch (err) {
        // The one caller mistake `startDevTunnel` throws on. Anything else is the route render
        // failing, whose text can carry cluster detail, so it is logged rather than returned.
        if ((err as Error)?.message === INVALID_SSH_PUBLIC_KEY)
          return { status: 400, json: { error: 'Invalid SSH public key', code: 'BAD_REQUEST' } };
        // Its caller cancelled it (or the deadline below did): it closed what it opened.
        if ((err as Error)?.message === DEV_TUNNEL_START_CANCELLED) {
          log('cancelled');
          return { status: 409, json: { error: 'The start was cancelled', code: 'cancelled' } };
        }
        throw err;
      }

      // No host key means the sandbox cannot pin it, so it must not connect: close what was opened.
      if (!started.sshHostPublicKey) {
        await stopDevTunnel(grant.userId, started.sessionId).catch(() => false);
        log('not-configured');
        return { status: 503, json: { error: 'The preview service is not configured' } };
      }

      log('started', { sessionId: started.sessionId });
      return {
        status: 200,
        json: {
          sessionId: started.sessionId,
          host: started.host,
          sshHostPublicKey: started.sshHostPublicKey,
        },
      };
    } catch (err) {
      log('failed', { error: safeError(err) });
      return UNAVAILABLE;
    }
  };

  // Past the deadline the start is cancelled and the runner hears `unavailable`. `open` never
  // rejects, so the fallback only ever stands for the deadline.
  const outcome = await withTimeoutFallback<Answer | 'deadline'>(
    open(),
    RUNNER_DEV_TUNNEL_START_DEADLINE_MS,
    'deadline'
  );
  if (outcome === 'deadline') {
    const cancelled = await cancelDevTunnelStart(grant.userId, clientKey).catch(
      () => 'unavailable' as const
    );
    log('deadline', { cancelled });
    return res.status(UNAVAILABLE.status).json(UNAVAILABLE.json);
  }
  return res.status(outcome.status).json(outcome.json);
});
