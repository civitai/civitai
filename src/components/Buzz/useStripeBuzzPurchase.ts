import { Currency } from '@prisma/client';
import { trpc } from '~/utils/trpc';
import { useElements, useStripe } from '@stripe/react-stripe-js';
import { useEffect, useState, useCallback } from 'react';
import { useInterval } from '@mantine/hooks';
import { PaymentIntent } from '@stripe/stripe-js';

export const useStripeBuzzPurchase = ({
  onPaymentSuccess,
  amount,
  currency = Currency.USD,
  ...metadata
}: {
  amount: number;
  currency?: Currency;
  onPaymentSuccess: () => void;
}) => {
  const [processingPayment, setProcessingPayment] = useState<boolean>(false);
  const { data, isLoading: isLoadingClientSecret } = trpc.stripe.getPaymentIntent.useQuery(
    { unitAmount: amount, currency, metadata },
    { enabled: !!amount && !!currency }
  );
  const clientSecret = data?.clientSecret;
  const stripe = useStripe();
  const elements = useElements();

  const fetchPaymentIntent = useCallback(
    async (secret: string) => {
      if (!stripe) {
        return;
      }

      return await stripe.retrievePaymentIntent(secret);
    },
    [stripe]
  );

  const paymentIntentProcessor = useInterval(async () => {
    if (!clientSecret) return;
    const data = await fetchPaymentIntent(clientSecret);
    if (!data) return;

    const { paymentIntent } = data;

    processPaymentIntent(paymentIntent);
  }, 350);

  const processPaymentIntent = useCallback(
    (paymentIntent?: PaymentIntent) => {
      if (!paymentIntent) {
        setPaymentIntentStatus('error');
        return;
      }

      switch (paymentIntent.status) {
        case 'succeeded':
          setPaymentIntentStatus('succeeded');
          onPaymentSuccess();
          setProcessingPayment(false);
          break;
        case 'processing':
          setPaymentIntentStatus('processing');
          setProcessingPayment(true);
          if (!paymentIntentProcessor.active) {
            paymentIntentProcessor.start();
          }
          break;
        case 'requires_payment_method':
          setPaymentIntentStatus('requires_payment_method');
          setErrorMessage('Your card was declined.');
          setProcessingPayment(false);
          break;
        default:
          setPaymentIntentStatus('error');
          setErrorMessage('Something went wrong.');
          setProcessingPayment(false);
          break;
      }
    },
    [onPaymentSuccess, paymentIntentProcessor]
  );

  const [paymentIntentStatus, setPaymentIntentStatus] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    if (!processingPayment && paymentIntentProcessor.active) {
      paymentIntentProcessor.stop();
    }
  }, [processingPayment, paymentIntentProcessor]);

  const onConfirmPayment = async () => {
    if (!stripe || !elements) {
      // Stripe.js hasn't yet loaded.
      // Make sure to disable form submission until Stripe.js has loaded.
      return;
    }

    setProcessingPayment(true);

    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
      confirmParams: {
        // Make sure to change this to your payment completion page
        // TODO: change this to the actual return url. Used for paypal for example.
        return_url: 'http://localhost:3000',
      },
    });

    if (error) {
      // This point will only be reached if there is an immediate error when
      // confirming the payment. Otherwise, your customer will be redirected to
      // your `return_url`. For some payment methods like iDEAL, your customer will
      // be redirected to an intermediate site first to authorize the payment, then
      // redirected to the `return_url`.
      if (error.type === 'card_error' || error.type === 'validation_error') {
        setPaymentIntentStatus(error.type);
      } else {
        setPaymentIntentStatus('error');
      }

      setErrorMessage(error.message ?? 'Something went wrong.');
    }

    processPaymentIntent(paymentIntent);
  };

  return {
    stripe,
    elements,
    clientSecret,
    errorMessage,
    onConfirmPayment,
    processingPayment,
    isLoadingClientSecret,
    paymentIntentStatus,
  };
};
