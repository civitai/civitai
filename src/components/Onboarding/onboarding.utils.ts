import { useCurrentUser } from '~/hooks/useCurrentUser';
import { OnboardingSteps } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { Flags } from '~/shared/utils';
import { useDomainSettings } from '~/providers/DomainSettingsProvider';
import { useDomainColor } from '~/hooks/useDomainColor';

const onboardingSteps: Record<string, OnboardingSteps[]> = {
  default: [
    OnboardingSteps.TOS,
    OnboardingSteps.RedTOS,
    OnboardingSteps.Profile,
    OnboardingSteps.BrowsingLevels,
    OnboardingSteps.Buzz,
  ],
  red: [
    OnboardingSteps.RedTOS,
    OnboardingSteps.Profile,
    OnboardingSteps.BrowsingLevels,
    OnboardingSteps.Buzz,
  ],
};

export const useGetRequiredOnboardingSteps = () => {
  const currentUser = useCurrentUser();
  const domainColor = useDomainColor();

  if (!currentUser) return [];

  const steps = onboardingSteps[domainColor] || onboardingSteps.default;
  console.log(currentUser.onboarding);
  return steps.filter((step) => !Flags.hasFlag(currentUser.onboarding, step));
};

export const useOnboardingStepCompleteMutation = () => {
  const currentUser = useCurrentUser();
  return trpc.user.completeOnboardingStep.useMutation({
    async onSuccess() {
      await currentUser?.refresh();
    },
    onError(error) {
      showErrorNotification({
        title: 'Cannot save',
        error: new Error(error.message),
      });
    },
  });
};
