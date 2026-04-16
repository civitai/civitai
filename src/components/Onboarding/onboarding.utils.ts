import { useCurrentUser } from '~/hooks/useCurrentUser';
import { OnboardingSteps } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { Flags } from '~/shared/utils/flags';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useOnboardingContext } from '~/components/Onboarding/OnboardingProvider';

const onboardingSteps: Record<string, OnboardingSteps[]> = {
  default: [
    OnboardingSteps.TOS,
    OnboardingSteps.Profile,
    OnboardingSteps.BrowsingLevels,
    OnboardingSteps.Buzz,
  ],
  // Green domain is SFW-only. BrowsingLevels step only exposes mature-content
  // controls, so skip it entirely on green.
  green: [OnboardingSteps.TOS, OnboardingSteps.Profile, OnboardingSteps.Buzz],
};

export const useGetRequiredOnboardingSteps = () => {
  const currentUser = useCurrentUser();
  const domainColor = useDomainColor();

  if (!currentUser) return [];

  const steps = onboardingSteps[domainColor] || onboardingSteps.default;
  return steps.filter((step) => !Flags.hasFlag(currentUser.onboarding, step));
};

export const useOnboardingStepCompleteMutation = () => {
  const currentUser = useCurrentUser();
  const { isPreview } = useOnboardingContext();
  const realMutation = trpc.user.completeOnboardingStep.useMutation({
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

  if (!isPreview) return realMutation;

  return {
    ...realMutation,
    mutate: ((_input: unknown, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    }) as unknown as typeof realMutation.mutate,
    mutateAsync: (async (_input: unknown, opts?: { onSuccess?: () => void }) => {
      opts?.onSuccess?.();
    }) as unknown as typeof realMutation.mutateAsync,
    isLoading: false,
    error: null,
  };
};
