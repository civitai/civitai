import { CurrencyCode } from '@paddle/paddle-js';
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

const MAX_RETRIES = Math.floor(STRIPE_PROCESSING_AWAIT_TIME / STRIPE_PROCESSING_CHECK_INTERVAL);
const CHECK_INTERVAL = STRIPE_PROCESSING_CHECK_INTERVAL;

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
  const { getToken } = useRecaptchaToken(RECAPTCHA_ACTIONS.STRIPE_TRANSACTION);
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
        // recaptchaToken: recaptchaToken as string,
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
}: {
  onPaymentSuccess?: (transactionId: string) => Promise<void>;
  transactionId?: string;
  containerName?: string;
}) => {
  const paddle = usePaddle();
  const theme = useMantineTheme();
  const [processingPayment, setProcessingPayment] = useState<boolean>(false);
  const retries = useRef<number>(0);

  useEffect(() => {
    if (transactionId) {
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
    }
  }, [transactionId, paddle, containerName]);

  return {};
};
