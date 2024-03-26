import { useCurrentUser } from '~/hooks/useCurrentUser';
import { OnboardingSteps } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { Flags } from '~/shared/utils';

export const onboardingSteps = [
  OnboardingSteps.TOS,
  OnboardingSteps.Profile,
  OnboardingSteps.BrowsingLevels,
  OnboardingSteps.Buzz,
];

export const useGetRequiredOnboardingSteps = () => {
  const currentUser = useCurrentUser();
  if (!currentUser) return [];
  return onboardingSteps.filter((step) => !Flags.hasFlag(currentUser.onboarding, step));
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
