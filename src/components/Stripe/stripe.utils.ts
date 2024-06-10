import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import {
  PaymentIntentMetadataSchema,
  PaymentMethodDeleteInput,
} from '~/server/schema/stripe.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCallback, useEffect, useState } from 'react';
import { useRecaptchaToken } from '~/components/Recaptcha/useReptchaToken';
import { RECAPTCHA_ACTIONS } from '~/server/common/constants';
import { Currency } from '@prisma/client';
import { useDebouncer } from '~/utils/debouncer';

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

export const usePaymentIntent = ({
  unitAmount,
  currency = Currency.USD,
  metadata,
  desiredPaymentMethodTypes,
}: {
  unitAmount: number;
  currency?: Currency;
  metadata: PaymentIntentMetadataSchema;
  desiredPaymentMethodTypes?: string[];
}) => {
  const [setupFuturePayment, setSetupFuturePayment] = useState(true);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [paymentMethodTypes, setPaymentMethodTypes] = useState<string[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const getPaymentIntentMutation = trpc.stripe.getPaymentIntent.useMutation();

  // const { data, isLoading, isFetching, error } = trpc.stripe.getPaymentIntent.useQuery(
  //   {
  //     unitAmount,
  //     currency,
  //     metadata,
  //     paymentMethodTypes: desiredPaymentMethodTypes,
  //     recaptchaToken: recaptchaToken as string,
  //     setupFuturePayment,
  //   },
  //   {
  //     cacheTime: 0,
  //     trpc: { context: { skipBatch: true } },
  //     enabled: !!unitAmount && !!currency && !!recaptchaToken,
  //   }
  // );

  const { getToken } = useRecaptchaToken(RECAPTCHA_ACTIONS.STRIPE_TRANSACTION);
  const debouncer = useDebouncer(300);
  const getPaymentIntent = useCallback(async () => {
    setClientSecret(null);
    setPaymentMethodTypes(undefined);
    setError(null);
    setIsLoading(true);

    try {
      const recaptchaToken = await getToken();

      if (!recaptchaToken) {
        throw new Error('Unable to get recaptcha token.');
      }

      const data = await getPaymentIntentMutation.mutateAsync({
        unitAmount,
        currency,
        metadata,
        paymentMethodTypes: desiredPaymentMethodTypes,
        setupFuturePayment,
        recaptchaToken: recaptchaToken as string,
      });

      setClientSecret(data.clientSecret);
      setPaymentMethodTypes(data.paymentMethodTypes);
    } catch (err: any) {
      setError(err?.message ?? err ?? 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  }, [unitAmount, currency, metadata, desiredPaymentMethodTypes, setupFuturePayment, getToken]);

  useEffect(() => {
    debouncer(() => getPaymentIntent());
  }, [setupFuturePayment]);

  return {
    clientSecret,
    paymentMethodTypes,
    isLoading,
    setupFuturePayment,
    setSetupFuturePayment,
    error,
  };
};
