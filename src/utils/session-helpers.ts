import { TokenUser } from 'next-auth';
import { OnboardingSteps } from '~/server/common/enums';
import { Flags } from '~/utils/flags';

export function extendedSessionUser(user: TokenUser) {
  return {
    ...user,
    isMember: user.tier != null,
    showNsfw: user.browsingLevel > 0,
    tos: Flags.hasFlag(user.onboarding, OnboardingSteps.TOS),
    onboardingSteps: Flags.instanceToArray(user.onboarding) as OnboardingSteps[],
    // TODO - computed db prop for mod levels
  };
}
