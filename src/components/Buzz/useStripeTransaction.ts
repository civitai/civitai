import { useElements, useStripe } from '@stripe/react-stripe-js';
import { useEffect, useState, useCallback } from 'react';
import { useInterval } from '@mantine/hooks';
import { PaymentIntent } from '@stripe/stripe-js';

export const useStripeTransaction = ({
  onPaymentSuccess,
  clientSecret,
}: {
  onPaymentSuccess: (stripePaymentIntentId: string) => void;
  clientSecret: string;
  metadata?: any;
}) => {
  const [processingPayment, setProcessingPayment] = useState<boolean>(false);

  const stripe = useStripe();
  const elements = useElements();

  const fetchPaymentIntent = useCallback(
    async (secret: string) => {
      if (!stripe) {
        return;
      }

      return await stripe.retrievePaymentIntent(secret);
    },
    [stripe, clientSecret]
  );

  const paymentIntentProcessor = useInterval(async () => {
    if (!clientSecret) return;
    const data = await fetchPaymentIntent(clientSecret);
    if (!data) return;

    const { paymentIntent } = data;

    processPaymentIntent(paymentIntent);
  }, 350);

  const processPaymentIntent = useCallback(
    async (paymentIntent?: PaymentIntent) => {
      if (!paymentIntent) {
        setPaymentIntentStatus('error');
        setProcessingPayment(false);
        return;
      }

      switch (paymentIntent.status) {
        case 'succeeded':
          setPaymentIntentStatus('succeeded');
          await onPaymentSuccess?.(paymentIntent.id);
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

    return paymentIntentProcessor.stop;
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
        // TODO.stripePayments: change this to the actual return url. Used for paypal for example. In the meantime, won't be used I believe.
        return_url: 'http://localhost:3000/todo',
      },
    });

    if (error) {
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
    errorMessage,
    onConfirmPayment,
    processingPayment,
    paymentIntentStatus,
  };
};
