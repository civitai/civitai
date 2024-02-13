import { TokenUser } from 'next-auth';
import { onboardingSteps } from '~/components/Onboarding/onboarding.utils';
import { OnboardingSteps } from '~/server/common/enums';
import { Flags } from '~/utils/flags';

export function extendedSessionUser(user: TokenUser) {
  const steps = Flags.instanceToArray(user.onboarding) as OnboardingSteps[];
  return {
    ...user,
    isMember: user.tier != null,
    tos: Flags.hasFlag(user.onboarding, OnboardingSteps.TOS),
    onboardingSteps: steps,
    // TODO - computed db prop for mod levels
  };
}
