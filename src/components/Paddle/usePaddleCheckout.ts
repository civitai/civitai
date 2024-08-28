import { CurrencyCode } from '@paddle/paddle-js';
import { useState, useCallback } from 'react';
import { RECAPTCHA_ACTIONS } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';
import { useRecaptchaToken } from '~/components/Recaptcha/useReptchaToken';
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
  const { getToken, loading: isLoadingToken } = useRecaptchaToken(
    RECAPTCHA_ACTIONS.PADDLE_TRANSACTION,
    false
  );

  const getTransaction = useCallback(async () => {
    if (isLoading || createTransactionMutation.isLoading || isLoadingToken) return;

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
  }, [unitAmount, currency, getToken, createTransactionMutation]);

  const debouncer = useDebouncer(300);
  const debouncedGetTransaction = useCallback(() => {
    debouncer(getTransaction);
  }, [getTransaction, debouncer]);

  return {
    error,
    transactionId,
    isLoading: isLoading || isLoadingToken,
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
