import {
  Button,
  Center,
  Group,
  Stack,
  Text,
  Divider,
  Loader,
  useMantineTheme,
  Title,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import React, { useEffect, useMemo, useState } from 'react';

import { createContextModal } from '~/components/Modals/utils/createContextModal';
import { Elements, PaymentElement } from '@stripe/react-stripe-js';
import { StripeElementsOptions, StripePaymentElementOptions } from '@stripe/stripe-js';
import { useStripePromise } from '~/providers/StripeProvider';
import { useStripeTransaction } from '~/components/Buzz/useStripeTransaction';
import { formatPriceForDisplay } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { PaymentIntentMetadataSchema } from '~/server/schema/stripe.schema';
import { useTrackEvent } from '../TrackView/track.utils';
import { closeAllModals } from '@mantine/modals';
import { useUserPaymentMethods } from '~/components/Stripe/stripe.utils';
import { PaymentMethodItem } from '~/components/Account/PaymentMethodsCard';
import { useRecaptchaToken } from '../Recaptcha/useReptchaToken';
import { RECAPTCHA_ACTIONS } from '../../server/common/constants';
import { RecaptchaNotice } from '../Recaptcha/RecaptchaWidget';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { IconAlertCircle } from '@tabler/icons-react';

const Error = ({ error, onClose }: { error: string; onClose: () => void }) => (
  <Stack>
    <Title order={3}>Whoops!</Title>
    <AlertWithIcon
      icon={<IconAlertCircle />}
      color="red"
      iconColor="red"
      title="Sorry, it looks like there was an error"
    >
      {error}
    </AlertWithIcon>

    <RecaptchaNotice />

    <Center>
      <Button onClick={onClose}>Close this window</Button>
    </Center>
  </Stack>
);

const StripeTransactionModal = ({
  unitAmount,
  currency,
  message,
  onSuccess,
  onClose,
  metadata,
  clientSecret,
  successMessage,
  paymentMethodTypes = [],
}: Props & { clientSecret: string; onClose: () => void; paymentMethodTypes?: string[] }) => {
  const { userPaymentMethods, isLoading: isLoadingPaymentMethods } = useUserPaymentMethods();
  const [success, setSuccess] = useState<boolean>(false);
  const supportedUserPaymentMethods = useMemo(() => {
    return userPaymentMethods?.filter((method) => paymentMethodTypes.includes(method.type)) ?? [];
  }, [userPaymentMethods, paymentMethodTypes]);

  const { trackAction } = useTrackEvent();

  const { processingPayment, onConfirmPayment, errorMessage, paymentIntentStatus } =
    useStripeTransaction({
      clientSecret,
      onPaymentSuccess: async (stripePaymentIntent) => {
        await onSuccess?.(stripePaymentIntent.id);
        setSuccess(true);
      },
      metadata,
    });

  const paymentElementOptions: StripePaymentElementOptions = {
    layout: 'tabs',
  };

  const processingTooLong = paymentIntentStatus === 'processing_too_long';

  if (success) {
    return (
      <Stack>
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Complete your transaction
          </Text>
        </Group>
        <Divider mx="-lg" />
        {successMessage ? <>{successMessage}</> : <Text>Thank you for your purchase!</Text>}
        <Button
          onClick={() => {
            closeAllModals();
            onClose();
          }}
        >
          Close
        </Button>
      </Stack>
    );
  }

  return (
    <form
      id="stripe-payment-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const paymentIntent = await onConfirmPayment();
        if (paymentIntent)
          trackAction({
            type: 'PurchaseFunds_Confirm',
            details: { ...metadata, method: paymentIntent.payment_method?.type },
          }).catch(() => undefined);
      }}
    >
      <Stack spacing="md">
        <Group position="apart" noWrap>
          <Text size="lg" weight={700}>
            Complete your transaction
          </Text>
        </Group>
        <Divider mx="-lg" />
        {message && <>{message}</>}

        {(supportedUserPaymentMethods?.length ?? 0) > 0 && (
          <Stack>
            <Divider mx="-lg" />
            <Text weight="bold">Saved payment methods</Text>
            <Stack spacing="sm">
              {supportedUserPaymentMethods.map((paymentMethod) => (
                <PaymentMethodItem key={paymentMethod.id} paymentMethod={paymentMethod}>
                  <Button
                    color="blue"
                    onClick={async () => {
                      const paymentIntent = await onConfirmPayment(paymentMethod.id);
                      trackAction({
                        type: 'PurchaseFunds_Confirm',
                        details: { ...metadata, method: paymentMethod.type },
                      }).catch(() => undefined);
                    }}
                    disabled={processingPayment || processingTooLong}
                    loading={processingPayment}
                  >
                    Pay ${formatPriceForDisplay(unitAmount, currency)}
                  </Button>
                </PaymentMethodItem>
              ))}
            </Stack>
            <Divider mx="-lg" />
            <Text weight="bold">Add new payment method</Text>
          </Stack>
        )}
        <PaymentElement id="payment-element" options={paymentElementOptions} />
        {errorMessage && (
          <Text color="red" size="sm">
            {errorMessage}
          </Text>
        )}

        <RecaptchaNotice />

        <Group position="right">
          <Button
            variant="filled"
            color="gray"
            onClick={() => {
              trackAction({ type: 'PurchaseFunds_Cancel', details: { step: 2 } }).catch(
                () => undefined
              );
              onClose();
            }}
            disabled={processingPayment}
          >
            {processingTooLong ? 'Close' : 'Cancel'}
          </Button>
          <Button
            component="button"
            disabled={processingPayment || processingTooLong}
            loading={processingPayment}
            type="submit"
          >
            {processingPayment
              ? 'Processing...'
              : `Pay $${formatPriceForDisplay(unitAmount, currency)}`}
          </Button>
        </Group>
      </Stack>
    </form>
  );
};

type Props = {
  successMessage?: React.ReactNode;
  message?: React.ReactNode;
  unitAmount: number;
  currency?: Currency;
  onSuccess?: (stripePaymentIntentId: string) => Promise<void>;
  metadata: PaymentIntentMetadataSchema;
  paymentMethodTypes?: string[];
};

const { openModal, Modal } = createContextModal<Props>({
  name: 'stripeTransaction',
  withCloseButton: false,
  size: 'lg',
  radius: 'lg',
  closeOnEscape: false,
  closeOnClickOutside: false,
  zIndex: 400,
  Element: ({
    context,
    props: {
      unitAmount,
      currency = Currency.USD,
      metadata,
      paymentMethodTypes: desiredPaymentMethodTypes,
      ...props
    },
  }) => {
    const theme = useMantineTheme();
    const stripePromise = useStripePromise();
    const {
      token: recaptchaToken,
      loading: isLoadingRecaptcha,
      error: recaptchaError,
    } = useRecaptchaToken(RECAPTCHA_ACTIONS.STRIPE_TRANSACTION);

    const { data, isLoading, isFetching, error } = trpc.stripe.getPaymentIntent.useQuery(
      {
        unitAmount,
        currency,
        metadata,
        paymentMethodTypes: desiredPaymentMethodTypes,
        recaptchaToken: recaptchaToken as string,
      },
      {
        enabled: !!unitAmount && !!currency && !!recaptchaToken,
        refetchOnMount: 'always',
        cacheTime: 0,
        trpc: { context: { skipBatch: true } },
      }
    );

    const { isLoading: isLoadingPaymentMethods } = useUserPaymentMethods({
      enabled: !!data?.clientSecret,
    });

    const clientSecret = data?.clientSecret;
    const paymentMethodTypes = data?.paymentMethodTypes;

    if (isLoading || isFetching || isLoadingPaymentMethods || isLoadingRecaptcha) {
      return (
        <Center>
          <Loader variant="bars" />
        </Center>
      );
    }

    const handleClose = () => {
      context.close();
    };

    if (!recaptchaToken) {
      return (
        <Error error={recaptchaError ?? 'Unable to get recaptcha token.'} onClose={handleClose} />
      );
    }

    if (!clientSecret) {
      return (
        <Error
          error={
            error?.message ??
            'We are unable to connect you with Stripe services to perform a transaction. Please try again later.'
          }
          onClose={handleClose}
        />
      );
    }

    const options: StripeElementsOptions = {
      clientSecret,
      appearance: { theme: theme.colorScheme === 'dark' ? 'night' : 'stripe' },
      locale: 'en',
    };

    return (
      <Elements stripe={stripePromise} key={clientSecret} options={options}>
        <StripeTransactionModal
          clientSecret={clientSecret}
          key={clientSecret}
          onClose={handleClose}
          unitAmount={unitAmount}
          currency={currency}
          metadata={metadata}
          // This is the payment methods we will end up supporting based off of
          // the payment intent instead of the ones we "wish" to support.
          paymentMethodTypes={paymentMethodTypes}
          {...props}
        />
      </Elements>
    );
  },
});

export const openStripeTransactionModal = openModal;
export default Modal;
