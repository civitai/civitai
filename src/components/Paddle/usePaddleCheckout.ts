import type { CurrencyCode } from '@paddle/paddle-js';
import { useState, useCallback } from 'react';
import { trpc } from '~/utils/trpc';
import { useDebouncer } from '~/utils/debouncer';

export const usePaddleBuzzTransaction = ({
  unitAmount,
  currency = 'USD',
}: {
  unitAmount: number;
  currency?: CurrencyCode;
}) => {
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const createTransactionMutation = trpc.paddle.createBuzzPurchaseTransaction.useMutation();

  const getTransaction = useCallback(
    (captchaToken: string | null) => async () => {
      if (isLoading || createTransactionMutation.isLoading) return;

      setTransactionId(null);
      setError(null);
      setIsLoading(true);

      try {
        if (!captchaToken) {
          throw new Error('Unable to get captcha token.');
        }

        const data = await createTransactionMutation.mutateAsync({
          unitAmount,
          currency,
          recaptchaToken: captchaToken,
        });

        setTransactionId(data.transactionId);
      } catch (err: any) {
        setError(err?.message ?? err ?? 'An error occurred');
      } finally {
        setIsLoading(false);
      }
    },
    [unitAmount, currency, createTransactionMutation, isLoading]
  );

  const debouncer = useDebouncer(300);
  const debouncedGetTransaction = useCallback(
    (captchaToken: string | null) => {
      debouncer(getTransaction(captchaToken));
    },
    [getTransaction, debouncer]
  );

  return {
    error,
    transactionId,
    isLoading,
    getTransaction: debouncedGetTransaction,
  };
};

// TODORemove: Ended up using their overlay checkout. Will leave this here for now just in case
// We wanna roll it back, but prob. not ever needed again.
//
// export const usePaddleCheckout = ({
//   transactionId,
//   containerName = 'checkout-container',
//   onPaymentSuccess,
// }: {
//   onPaymentSuccess?: (transactionId: string) => Promise<void>;
//   transactionId?: string;
//   containerName?: string;
// }) => {
//   const { paddle, emitter } = usePaddle();
//   const theme = useMantineTheme();

//   const trackTransaction = useCallback(
//     (data?: CheckoutEventsData) => {
//       if (transactionId && data?.transaction_id === transactionId) {
//         onPaymentSuccess?.(transactionId as string);
//       }
//     },
//     [transactionId, onPaymentSuccess]
//   );

//   useEffect(() => {
//     if (transactionId) {
//       try {
//         paddle.Checkout.open({
//           settings: {
//             displayMode: 'inline',
//             frameTarget: containerName,
//             frameInitialHeight: 450, // Recommended by paddle
//             frameStyle: `width: 100%; min-width: 312px; background-color: transparent; border: none; font-family: ${theme.fontFamily};`,
//             theme: theme.colorScheme === 'dark' ? 'dark' : 'light',
//           },
//           transactionId,
//         });

//         emitter.on('checkout.completed', trackTransaction);
//       } catch (err) {
//         console.error(err);
//       }
//     }

//     return () => {
//       emitter.off('checkout.completed', trackTransaction);
//     };
//   }, [transactionId, paddle, containerName]);

//   return {};
// };
