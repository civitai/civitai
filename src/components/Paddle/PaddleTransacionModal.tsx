import {
  Button,
  Center,
  Stack,
  Loader,
  Title,
  Modal,
  ModalProps,
  Divider,
  Text,
  Group,
  Paper,
  useMantineTheme,
  CloseButton,
  Alert,
  Anchor,
} from '@mantine/core';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { IconAlertCircle } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { usePaddleBuzzTransaction } from '~/components/Paddle/usePaddleCheckout';
import type { CheckoutEventsData, CurrencyCode } from '@paddle/paddle-js';
import { usePaddle } from '~/providers/PaddleProvider';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { formatPriceForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { useMutatePaddle } from '~/components/Paddle/util';
import {
  CaptchaState,
  TurnstilePrivacyNotice,
  TurnstileWidget,
} from '~/components/TurnstileWidget/TurnstileWidget';
import { TimeoutLoader } from '../Search/TimeoutLoader';
import { RefreshSessionButton } from '../RefreshSessionButton/RefreshSessionButton';

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

    <TurnstilePrivacyNotice />

    <Center>
      <Button onClick={onClose}>Close this window</Button>
    </Center>
  </Stack>
);

export default function PaddleTransactionModal({
  unitAmount,
  currency,
  onSuccess,
  message,
  successMessage,
}: Props) {
  const dialog = useDialogContext();
  const theme = useMantineTheme();
  const {
    transactionId,
    error: transactionError,
    isLoading: paddleTransactionLoading,
    getTransaction,
  } = usePaddleBuzzTransaction({ unitAmount, currency });
  const { subscription, subscriptionLoading, subscriptionPaymentProvider } =
    useActiveSubscription();
  const { emitter, paddle } = usePaddle();
  const { purchaseBuzzWithSubscription, purchasingBuzzWithSubscription } = useMutatePaddle();
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>();
  const [processingSuccess, setProcessingSuccess] = useState(false);
  const [captchaState, setCaptchaState] = useState<CaptchaState>({
    status: null,
    token: null,
    error: null,
  });

  const onCheckoutComplete = useCallback(
    (data?: CheckoutEventsData) => {
      if (transactionId && data?.transaction_id === transactionId) {
        onSuccess?.(transactionId as string);
        dialog.onClose();
      }
    },
    [transactionId, onSuccess, dialog]
  );

  useEffect(() => {
    if (transactionId) {
      try {
        paddle.Checkout.open({
          transactionId,
        });

        emitter.on('checkout.completed', onCheckoutComplete);
        emitter.on('checkout.closed', dialog.onClose);
      } catch (err) {
        console.error(err);
      }
    }

    return () => {
      emitter.off('checkout.completed', onCheckoutComplete);
      emitter.off('checkout.closed', dialog.onClose);
    };
  }, [transactionId, paddle, emitter, onCheckoutComplete, dialog.onClose]);

  useEffect(() => {
    if (
      !transactionError &&
      !paddleTransactionLoading &&
      !transactionId &&
      !subscriptionLoading &&
      (!subscription || subscriptionPaymentProvider !== PaymentProvider.Paddle) &&
      captchaState.status === 'success'
    ) {
      // Go ahead and automatically trigger the checkout
      getTransaction(captchaState.token);
    }
  }, [
    transactionError,
    subscription,
    subscriptionLoading,
    subscriptionPaymentProvider,
    getTransaction,
    transactionId,
    paddleTransactionLoading,
    captchaState.status,
    captchaState.token,
  ]);

  const handlePurchaseWithSubscription = useCallback(async () => {
    try {
      const resultTransactionId = await purchaseBuzzWithSubscription({
        unitAmount,
        currency: currency ?? 'USD',
      });

      if (!!resultTransactionId) {
        setProcessingSuccess(true);
        await onSuccess?.(resultTransactionId);
        setProcessingSuccess(false);
      }

      setSuccess(true);
    } catch (e: any) {
      setError(e?.message ?? e ?? 'An error occurred');
    }
  }, [setProcessingSuccess, purchaseBuzzWithSubscription, unitAmount, currency, onSuccess]);

  const modalProps: Partial<ModalProps> = useMemo(
    () => ({
      withCloseButton: false,
      size: 'md',
      radius: 'lg',
      closeOnEscape: false,
      closeOnClickOutside: false,
      zIndex: 400,
    }),
    []
  );

  if (
    subscriptionLoading ||
    paddleTransactionLoading ||
    processingSuccess ||
    (captchaState.status !== 'error' && !captchaState.token)
  ) {
    return (
      <Modal {...dialog} {...modalProps}>
        <Stack gap="md">
          <Center>
            <TimeoutLoader
              renderTimeout={() => (
                <Alert color="red" title="Looks like we have an issue!">
                  <Text>
                    Seems we&rsquo;re having trouble connecting you with our payment processor, Try
                    to <RefreshSessionButton />, use a different browser or trying again later. If
                    you&rsquo;re still unable to checkout, please contact support{' '}
                    <Anchor href="https://civitai.com/support">here</Anchor>
                  </Text>
                </Alert>
              )}
              delay={30000}
            />
          </Center>

          <TurnstilePrivacyNotice />
          <TurnstileWidget
            onSuccess={(token) => setCaptchaState({ status: 'success', token, error: null })}
            onError={(error) =>
              setCaptchaState({
                status: 'error',
                token: null,
                error: `There was an error generating the captcha: ${error}`,
              })
            }
            onExpire={(token) =>
              setCaptchaState({ status: 'expired', token, error: 'Captcha token expired' })
            }
          />
        </Stack>
      </Modal>
    );
  }

  if (
    (transactionError && !paddleTransactionLoading && !transactionId) ||
    captchaState.status === 'error'
  ) {
    return (
      <Modal {...dialog} {...modalProps}>
        <Error error={captchaState.error ?? transactionError ?? ''} onClose={dialog.onClose} />
      </Modal>
    );
  }

  if (success) {
    return (
      <Modal {...dialog} {...modalProps}>
        <Stack>
          <Group justify="space-between" wrap="nowrap">
            <Text size="lg" weight={700}>
              Complete your transaction
            </Text>
          </Group>
          <Divider mx="-lg" />
          {successMessage ? <>{successMessage}</> : <Text>Thank you for your purchase!</Text>}
          <Button
            onClick={() => {
              dialog.onClose();
            }}
          >
            Close
          </Button>
        </Stack>
      </Modal>
    );
  }

  if (transactionId) {
    // Let the paddle modal handle things
    return null;
  }

  // Wanna keep the component live for the event listeners
  return (
    <Modal {...dialog} {...modalProps}>
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Text size="lg" weight={700}>
            Complete your transaction
          </Text>
          <CloseButton onClick={dialog.onClose} />
        </Group>
        <Divider mx="-lg" />
        {message && <>{message}</>}
        <Stack gap={0}>
          <Text size="sm" color="dimmed">
            Transaction details
          </Text>
          <Paper
            mb="xl"
            p="md"
            radius="md"
            withBorder
            className="border-yellow-6 bg-gray-2 dark:bg-dark-9"
          >
            <Group gap="sm" align="center">
              <Group gap={8} justify="space-between" sx={{ flexGrow: 1 }}>
                <Text size={20} weight={510} color="yellow.6">
                  {numberWithCommas(unitAmount * 10)} Buzz
                </Text>
                <Text
                  color={theme.colorScheme === 'dark' ? 'gray.0' : 'dark'}
                  size={20}
                  weight="bold"
                  sx={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  ${formatPriceForDisplay(unitAmount)} {currency}
                </Text>
              </Group>
            </Group>
          </Paper>
        </Stack>
        <Text>How would you like to pay for your transaction?</Text>
        <Stack gap={0}>
          <Stack>
            <Button
              onClick={() => {
                handlePurchaseWithSubscription();
              }}
              disabled={purchasingBuzzWithSubscription || !!transactionId}
              loading={purchasingBuzzWithSubscription}
              radius="xl"
            >
              Use Card on File
            </Button>
            {error && (
              <Text color="red" size="sm">
                {error}
              </Text>
            )}
          </Stack>
          <Divider size="sm" label="OR" my="sm" labelPosition="center" />
          <Button
            variant="outline"
            onClick={() =>
              captchaState.status === 'success' ? getTransaction(captchaState.token) : undefined
            }
            disabled={purchasingBuzzWithSubscription}
            radius="xl"
          >
            Use a different payment method
          </Button>
        </Stack>

        <TurnstilePrivacyNotice />
        <TurnstileWidget
          onSuccess={(token) => setCaptchaState({ status: 'success', token, error: null })}
          onError={(error) => setCaptchaState({ status: 'error', token: null, error })}
          onExpire={(token) =>
            setCaptchaState({ status: 'expired', token, error: 'Captcha token expired' })
          }
        />
      </Stack>
    </Modal>
  );
}

type Props = {
  unitAmount: number;
  successMessage?: React.ReactNode;
  message?: React.ReactNode;
  currency?: CurrencyCode;
  onSuccess?: (transactionId: string) => Promise<void>;
};
