import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { isSystemAccountMeta } from '@civitai/auth';
import { runnerMintReads, type RunnerMintReads } from '@civitai/db-queries/recipe-runner';
import { bearerTokenFromHeader, getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { BlockTokenService } from '~/server/services/block-token.service';
import {
  FORCED_SFW_CEILING,
  forcedSfwViewerLevel,
} from '~/server/services/blocks/dev-scoped-mint.service';
import { decideRunnerMint, RUNNER_TOKEN_SCOPE } from '~/server/services/blocks/runner-mint.service';
import { CONSENT_SPEND_SCOPE } from '~/server/services/blocks/scope-grant.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { getTrustedClientIp } from '~/server/utils/client-ip';
import { checkFixedWindow } from '~/server/utils/public-api-rate-limit';
import {
  appRateLimitMeta,
  type AppRateLimitId,
  sendAppRateLimited,
} from '~/server/utils/app-rate-limit';

const runnerRequestSchema = z.object({
  runner: z.object({
    authorizationId: z.string().min(1).max(64),
    runKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    amount: z.number().int().positive().max(1_000_000),
  }),
});

/** Whether a `/api/v1/block-tokens` body asks for a recipe-runner token. */
export function isRunnerMintRequest(body: unknown): boolean {
  return typeof body === 'object' && body !== null && Object.hasOwn(body, 'runner');
}

// checkFixedWindow, not claimRateLimitAttempt: these buckets key on an address and a client, not the
// session user, and must not exempt moderators.

/** Per (runner client, user): a run needs one mint, so a burst is a bug or a replay. */
const PER_USER_LIMIT = { max: 10, windowSeconds: 60 };
/** Per address, before the credential is known. */
const PER_IP_LIMIT = { max: 1200, windowSeconds: 60 };
/** Per runner client: every user it serves shares one ceiling. */
const PER_CLIENT_LIMIT = { max: 600, windowSeconds: 60 };

type SessionUser = NonNullable<
  NonNullable<Awaited<ReturnType<typeof getSessionFromBearerToken>>>['user']
>;

export interface RunnerMintDeps {
  appBlocksOn(user: SessionUser, req: NextApiRequest): boolean;
  offlineGrantOn(): Promise<boolean>;
  reads(): Promise<RunnerMintReads>;
  viewerLevel(userId: number): Promise<number>;
}

const liveDeps: RunnerMintDeps = {
  appBlocksOn: (user, req) => getFeatureFlags({ user, req }).appBlocks,
  offlineGrantOn: () => isFlipt(FLIPT_FEATURE_FLAGS.OAUTH_OFFLINE_GRANT),
  reads: async () => {
    const { kyselyWrite } = await import('~/server/db/kyselyDb');
    return runnerMintReads(kyselyWrite);
  },
  viewerLevel: forcedSfwViewerLevel,
};

/**
 * Mint a block token for one recipe run, for a runner client acting on a user's offline grant.
 * Only a bearer OAuth access token carrying exactly the runner scope reaches here; a session
 * cookie never does. The token may only submit that run's workflow (`verifyBlockToken`).
 */
export async function handleRunnerMint(
  req: NextApiRequest,
  res: NextApiResponse,
  deps: RunnerMintDeps = liveDeps
): Promise<void> {
  const refuse = (status: number, reason: string, error = 'Runner token refused') => {
    logToAxiom({
      name: 'block-token-runner-mint',
      type: 'info',
      payload: { outcome: 'refused', reason },
    });
    res.status(status).json({ error, reason });
  };
  const rateLimited = (id: AppRateLimitId, retryAfterSeconds: number) => {
    logToAxiom({
      name: 'block-token-runner-mint',
      type: 'info',
      payload: { outcome: 'refused', reason: 'rate_limited' },
    });
    sendAppRateLimited(res, appRateLimitMeta(id, retryAfterSeconds), 'Rate limit exceeded', {
      reason: 'rate_limited',
    });
  };

  const parsed = runnerRequestSchema.safeParse(req.body);
  if (!parsed.success) return refuse(400, 'body', 'Invalid request body');
  const bearer = bearerTokenFromHeader(req.headers.authorization);
  if (!bearer) return refuse(401, 'no_bearer', 'Unauthorized');

  // Generous: one runner address serves every user.
  const perIp = await checkFixedWindow(
    `block-token-runner-ip:${getTrustedClientIp(req) ?? 'unknown'}`,
    PER_IP_LIMIT.max,
    PER_IP_LIMIT.windowSeconds,
    { failOpen: false }
  );
  if (!perIp.allowed) {
    return rateLimited('apps.block-token-runner-mint-ip', perIp.retryAfterSeconds);
  }

  const session = await getSessionFromBearerToken(bearer, { allowRunnerMint: true });
  // Only a runner client's token, exactly runner + UserRead; any other OAuth token is refused
  // here, before it can draw on the runner limits.
  if (
    !session ||
    session.subject.type !== 'oauth' ||
    !session.user ||
    session.tokenScope !== RUNNER_TOKEN_SCOPE
  ) {
    return refuse(401, 'credential', 'Unauthorized');
  }
  const user = session.user;
  const clientId = session.subject.id;

  const perClient = await checkFixedWindow(
    `block-token-runner:${clientId}`,
    PER_CLIENT_LIMIT.max,
    PER_CLIENT_LIMIT.windowSeconds,
    { failOpen: false }
  );
  const perUser = perClient.allowed
    ? await checkFixedWindow(
        `block-token-runner:${clientId}:${user.id}`,
        PER_USER_LIMIT.max,
        PER_USER_LIMIT.windowSeconds,
        { failOpen: false }
      )
    : perClient;
  if (!perUser.allowed) {
    return rateLimited('apps.block-token-runner-mint', perUser.retryAfterSeconds);
  }

  if (isSystemAccountMeta(user.meta)) return refuse(403, 'system_account');
  if (user.bannedAt || user.muted) return refuse(403, 'user_restricted');
  if (!deps.appBlocksOn(user, req)) return refuse(403, 'apps_flag');
  if (!(await deps.offlineGrantOn())) return refuse(403, 'offline_flag');

  const decision = await deps
    .reads()
    .then((reads) =>
      decideRunnerMint(
        {
          userId: user.id,
          clientId,
          tokenScope: session.tokenScope,
          request: parsed.data.runner,
          now: new Date(),
        },
        reads
      )
    )
    .catch((error: unknown) => {
      logToAxiom({ name: 'block-token-runner-mint', type: 'error', error: safeError(error) });
      return null;
    });
  if (!decision) return refuse(503, 'unavailable', 'Runner mint is unavailable');
  if (!decision.ok) return refuse(403, decision.refusal);

  const { grant } = decision;
  const signed = await BlockTokenService.sign({
    userId: user.id,
    blockId: grant.appBlock.blockId,
    appId: grant.appBlock.appId,
    appBlockId: grant.appBlock.id,
    blockInstanceId: `rbi_${clientId}`,
    scopes: [CONSENT_SPEND_SCOPE],
    ctx: { entityType: 'none' },
    buzzBudget: grant.buzzBudget,
    maxBrowsingLevel: FORCED_SFW_CEILING,
    viewerBrowsingLevel: await deps.viewerLevel(user.id),
    runner: {
      runId: grant.runId,
      authorizationId: grant.authorizationId,
      runKey: parsed.data.runner.runKey,
    },
  });
  logToAxiom({
    name: 'block-token-runner-mint',
    type: 'info',
    payload: {
      outcome: 'minted',
      runId: grant.runId,
      authorizationId: grant.authorizationId,
      runnerClientId: clientId,
      jti: signed.jti,
    },
  });
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    token: signed.token,
    expiresAt: signed.expiresAt,
    runId: grant.runId,
    buzzBudget: grant.buzzBudget,
  });
}
