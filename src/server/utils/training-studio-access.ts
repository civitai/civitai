import type { NextApiRequest, NextApiResponse } from 'next';
import { OnboardingSteps } from '~/server/common/enums';
import { requiresEmailVerification } from '~/server/common/email-verification-gate';
import { isFlipt } from '~/server/flipt/client';
import {
  buildFliptContext,
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
  if (!(await userFeatureFlags(req, user)).trainingStudioUi)
    return refuse(res, 403, { error: 'Training Studio is not available on this account' });
  return true;
}

/** The standalone Studio's closed-beta gate (its `TRAINING_STUDIO_FLAG`): moderators, else Flipt. */
const STANDALONE_STUDIO_FLIPT_KEY = 'trainingStudio';

/**
 * The gates for the Studio's system-paid auto-label: `allowTrainingStudio`'s, then the same flags as
 * `training.submitAutoLabelWorkflow` (`trainingAutoLabelOrchestrator` is the operators' off switch),
 * then access to either Studio surface — the embed's `trainingStudioUi` or the standalone beta.
 */
export async function allowStudioAutoLabel(
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
): Promise<boolean> {
  if (!(await allowTrainingStudio(req, res, user, { pageFlag: false }))) return false;
  const features = await userFeatureFlags(req, user);
  if (!features.imageTraining || !features.trainingAutoLabelOrchestrator)
    return refuse(res, 403, { error: 'Auto-labeling is not available on this account' });
  if (features.trainingStudioUi || user.isModerator) return true;
  if (await isFlipt(STANDALONE_STUDIO_FLIPT_KEY, String(user.id), buildFliptContext(user)))
    return true;
  return refuse(res, 403, { error: 'Training Studio is not available on this account' });
}

// Same merge the client provider performs (overlay over host flags) — keep them in step, or the
// page renders for a user these endpoints refuse.
async function userFeatureFlags(req: NextApiRequest, user: SessionUser) {
  const hostFlags = getFeatureFlagsLazy({ user, req });
  const { features: userFeatures } = await getUserSettings(user.id);
  const overlay = computeUserFeatureFlagsOverlay(
    userFeatures,
    hostFlags,
    getFliptGatedEligibility({ user, req })
  );
  return { ...hostFlags, ...overlay };
}

function refuse(res: NextApiResponse, status: number, body: { error: string }): false {
  res.status(status).json(body);
  return false;
}
