import type { NextApiRequest, NextApiResponse } from 'next';
import { OnboardingSteps } from '~/server/common/enums';
import { requiresEmailVerification } from '~/server/common/email-verification-gate';
import {
  computeUserFeatureFlagsOverlay,
  getFeatureFlagsLazy,
  getFliptGatedEligibility,
} from '~/server/services/feature-flags.service';
import { getUserSettings } from '~/server/services/user.service';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

/**
 * The Training Studio's gates for its host endpoints: a full-scope session, then
 * `guardedProcedure`'s gates (trpc.ts: banned → onboarded → muted → email-verified) — keep them
 * in step — then, for the embed page, its feature flag. Answers the refusal itself and returns false.
 *
 * `pageFlag: false` skips the flag, for a call the standalone Studio also makes: it is gated by its
 * own flag, and a user who switched the embed back to the classic trainer still uses it.
 */
export async function allowTrainingStudio(
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser,
  { pageFlag = true }: { pageFlag?: boolean } = {}
): Promise<boolean> {
  if (!requireFullScopeSession(req, res)) return false;
  if (user.bannedAt)
    return refuse(res, 403, {
      error: 'You cannot perform this action because your account has been banned',
    });
  if (!Flags.hasFlag(user.onboarding, OnboardingSteps.Buzz))
    return refuse(res, 403, {
      error: 'You must complete the onboarding process before performing this action',
    });
  if (user.muted)
    return refuse(res, 403, {
      error: 'You cannot perform this action because your account has been restricted',
    });
  if (requiresEmailVerification(user))
    return refuse(res, 403, { error: 'Verify your email address to do this' });
  if (!pageFlag) return true;
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
    return refuse(res, 403, { error: 'Training Studio is not available on this account' });
  return true;
}

function refuse(res: NextApiResponse, status: number, body: { error: string }): false {
  res.status(status).json(body);
  return false;
}
