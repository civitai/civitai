import { useCurrentUser } from '~/hooks/useCurrentUser';
import { OnboardingSteps } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { invalidateModeratedContent } from '~/utils/query-invalidation-utils';

export const onboardingSteps = [
  OnboardingSteps.TOS,
  OnboardingSteps.Profile,
  OnboardingSteps.BrowsingLevels,
  OnboardingSteps.Buzz,
];

export const useGetRequiredOnboardingSteps = () => {
  const currentUser = useCurrentUser();
  if (!currentUser) return [];
  return onboardingSteps.filter((step) => !currentUser.onboardingSteps.includes(step));
};

export const useOnboardingStepCompleteMutation = () => {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  return trpc.user.completeOnboardingStep.useMutation({
    async onSuccess() {
      await currentUser?.refresh();
      await invalidateModeratedContent(utils);
      // context.closeModal(id);
    },
    onError(error) {
      showErrorNotification({
        title: 'Cannot save',
        error: new Error(error.message),
        // reason: 'An unknown error occurred. Please try again later',
      });
    },
  });
};
