import { CheckoutEventsData, CurrencyCode } from '@paddle/paddle-js';
import { useEffect, useState, useCallback, useRef } from 'react';
import {
  RECAPTCHA_ACTIONS,
  STRIPE_PROCESSING_AWAIT_TIME,
  STRIPE_PROCESSING_CHECK_INTERVAL,
} from '~/server/common/constants';
import { usePaddle } from '~/providers/PaddleProvider';
import { trpc } from '~/utils/trpc';
import { useDebouncer } from '~/utils/debouncer';
import { useRecaptchaToken } from '~/components/Recaptcha/useReptchaToken';
import { useMantineTheme } from '@mantine/core';

export const usePaddleTransaction = ({
  unitAmount,
  currency = 'USD',
}: {
  unitAmount: number;
  currency?: CurrencyCode;
}) => {
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const createTransactionMutation = trpc.paddle.createTrasaction.useMutation();
  const { getToken } = useRecaptchaToken(RECAPTCHA_ACTIONS.PADDLE_TRANSACTION);
  const debouncer = useDebouncer(300);

  const createTransaction = useCallback(async () => {
    if (createTransactionMutation.isLoading) return;

    setTransactionId(null);
    setError(null);
    setIsLoading(true);

    try {
      const recaptchaToken = await getToken();

      if (!recaptchaToken) {
        throw new Error('Unable to get recaptcha token.');
      }

      const data = await createTransactionMutation.mutateAsync({
        unitAmount,
        currency,
        recaptchaToken: recaptchaToken as string,
      });

      setTransactionId(data.transactionId);
    } catch (err: any) {
      setError(err?.message ?? err ?? 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  }, [unitAmount, currency, getToken]);

  useEffect(() => {
    debouncer(() => createTransaction());
  }, [createTransaction, debouncer]);

  return {
    transactionId,
    isLoading,
    error,
  };
};

export const usePaddleCheckout = ({
  transactionId,
  containerName = 'checkout-container',
  onPaymentSuccess,
}: {
  onPaymentSuccess?: (transactionId: string) => Promise<void>;
  transactionId?: string;
  containerName?: string;
}) => {
  const { paddle, emitter } = usePaddle();
  const theme = useMantineTheme();

  const trackTransaction = useCallback(
    (data?: CheckoutEventsData) => {
      if (transactionId && data?.transaction_id === transactionId) {
        onPaymentSuccess?.(transactionId as string);
      }
    },
    [transactionId, onPaymentSuccess]
  );

  useEffect(() => {
    if (transactionId) {
      try {
        paddle.Checkout.open({
          settings: {
            displayMode: 'inline',
            frameTarget: containerName,
            frameInitialHeight: 450, // Recommended by paddle
            frameStyle: `width: 100%; min-width: 312px; background-color: transparent; border: none; font-family: ${theme.fontFamily};`,
            theme: theme.colorScheme === 'dark' ? 'dark' : 'light',
          },
          transactionId,
        });

        emitter.on('checkout.completed', trackTransaction);
      } catch (err) {
        console.error(err);
      }
    }

    return () => {
      emitter.off('checkout.completed', trackTransaction);
    };
  }, [transactionId, paddle, containerName]);

  return {};
};
