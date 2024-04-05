import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { PaymentMethodDeleteInput } from '~/server/schema/stripe.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export const useMutateStripe = () => {
  const queryUtils = trpc.useContext();

  const deletePaymentMethodMutation = trpc.user.deletePaymentMethod.useMutation({
    async onSuccess() {
      await queryUtils.user.getPaymentMethods.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to remove payment method',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to remove payment method',
          error: new Error(error.message),
        });
      }
    },
  });

  const handleDeletePaymentMethod = async (data: PaymentMethodDeleteInput) => {
    return deletePaymentMethodMutation.mutateAsync(data);
  };

  return {
    deletePaymentMethod: handleDeletePaymentMethod,
    deletingPaymentMethod: deletePaymentMethodMutation.isLoading,
  };
};

export const useUserPaymentMethods = (data: { enabled?: boolean } = { enabled: true }) => {
  const currentUser = useCurrentUser();
  const { data: userPaymentMethods = [], ...rest } = trpc.user.getPaymentMethods.useQuery(
    undefined,
    { enabled: !!currentUser && data?.enabled, trpc: { context: { skipBatch: true } } }
  );

  return {
    userPaymentMethods,
    ...rest,
  };
};

export const shortenPlanInterval = (interval?: string | null) => {
  if (interval === 'month') return 'mo';

  return interval ?? '';
};

export const useUserStripeConnect = () => {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const { data: userStripeConnect, isLoading } = trpc.userStripeConnect.get.useQuery(undefined, {
    enabled: !!features.creatorsProgram && !!currentUser,
  });

  return {
    userStripeConnect,
    isLoading,
  };
};
