import { env } from '~/env/server';
import { OnboardingSteps } from '~/server/common/enums';
import { requiresEmailVerification } from '~/server/common/email-verification-gate';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import {
  computeUserFeatureFlagsOverlay,
  getFeatureFlagsLazy,
  getFliptGatedEligibility,
} from '~/server/services/feature-flags.service';
import { getUserSettings } from '~/server/services/user.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';
import { Flags } from '~/shared/utils/flags';

/**
 * Host side of the embedded Training Studio (docs/training-studio-web-component.md).
 *
 * GET → { token, orchestratorMode } for the CALLER — /training-studio implements the element's
 * `getOrchestratorToken()` provider with this. No params; no side effects beyond the token cache
 * getOrchestratorToken already keeps. The orchestrator URL is NOT part of the response — see the
 * note at the `res.json` below.
 *
 * The token spends Buzz orchestrator-side, so it calls `requireFullScopeSession` first, then
 * mirrors `guardedProcedure`'s gates (trpc.ts: banned → onboarded → muted → email-verified)
 * plus the page's feature flag — keep them in step.
 */
export default AuthedEndpoint(async (req, res, user) => {
  if (!requireFullScopeSession(req, res)) return;
  if (user.bannedAt)
    return res
      .status(403)
      .json({ error: 'You cannot perform this action because your account has been banned' });
  if (!Flags.hasFlag(user.onboarding, OnboardingSteps.Buzz))
    return res
      .status(403)
      .json({ error: 'You must complete the onboarding process before performing this action' });
  if (user.muted)
    return res
      .status(403)
      .json({ error: 'You cannot perform this action because your account has been restricted' });
  if (requiresEmailVerification(user))
    return res.status(403).json({ error: 'Verify your email address to do this' });
  // Same merge the client provider performs (overlay over host flags) — keep them in step, or the
  // page renders for a user this endpoint refuses.
  const hostFlags = getFeatureFlagsLazy({ user, req });
  const { features: userFeatures } = await getUserSettings(user.id);
  const overlay = computeUserFeatureFlagsOverlay(
    userFeatures,
    hostFlags,
    getFliptGatedEligibility({ user, req })
  );
  if (!{ ...hostFlags, ...overlay }.trainingStudioUi)
    return res.status(403).json({ error: 'Training Studio is not available on this account' });

  const token = await getOrchestratorToken(user.id, { req, res });
  // In ORCHESTRATOR_MODE=dev getOrchestratorToken returns the SHARED service credential, which must
  // never reach a browser. Refuse unless local dev explicitly opted in.
  if (
    env.ORCHESTRATOR_ACCESS_TOKEN &&
    token === env.ORCHESTRATOR_ACCESS_TOKEN &&
    !env.ALLOW_DEV_ORCHESTRATOR_TOKEN_PASSTHROUGH
  )
    return res.status(500).json({
      error:
        'Refusing to send the shared dev orchestrator token to the browser. Set ALLOW_DEV_ORCHESTRATOR_TOKEN_PASSTHROUGH=true for local development.',
    });

  res.setHeader('Cache-Control', 'no-store');
  // 🔴 No `orchestratorEndpoint` here, deliberately. It used to return `env.ORCHESTRATOR_ENDPOINT`,
  // which is the in-cluster address — a value that must never reach a browser, for the same reason
  // the dev-token guard above exists. Nothing consumed it (the only caller, /training-studio, reads
  // `.token` alone), so it was a leak with no purpose. The browser gets the PUBLIC origin from
  // `NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT` instead. Do not re-add it from the server env.
  res.json({
    token,
    orchestratorMode: env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
  });
});
