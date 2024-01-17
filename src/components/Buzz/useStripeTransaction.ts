import { useElements, useStripe } from '@stripe/react-stripe-js';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useInterval } from '@mantine/hooks';
import { PaymentIntent, PaymentMethod } from '@stripe/stripe-js';
import {
  STRIPE_PROCESSING_AWAIT_TIME,
  STRIPE_PROCESSING_CHECK_INTERVAL,
} from '~/server/common/constants';
import { env } from '~/env/client.mjs';

const MAX_RETRIES = Math.floor(STRIPE_PROCESSING_AWAIT_TIME / STRIPE_PROCESSING_CHECK_INTERVAL);
const CHECK_INTERVAL = STRIPE_PROCESSING_CHECK_INTERVAL;

export const useStripeTransaction = ({
  onPaymentSuccess,
  clientSecret,
}: {
  onPaymentSuccess: (paymentIntent: PaymentIntent) => Promise<void>;
  clientSecret: string;
  metadata?: any;
}) => {
  const [processingPayment, setProcessingPayment] = useState<boolean>(false);
  const retries = useRef<number>(0);
  const stripe = useStripe();
  const elements = useElements();

  const fetchPaymentIntent = useCallback(
    async (secret: string) => {
      if (!stripe) return;

      return await stripe.retrievePaymentIntent(secret);
    },
    [stripe, clientSecret]
  );

  const paymentIntentProcessor = useInterval(async () => {
    if (retries.current >= MAX_RETRIES) {
      setPaymentIntentStatus('processing_too_long');
      setErrorMessage(
        'Your payment is taking too long to be processed. Once the payment goes through, you will receive a confirmation email and purchase will be completed.'
      );
      setProcessingPayment(false);
      return;
    }

    retries.current += 1;
    if (!clientSecret) return;
    const data = await fetchPaymentIntent(clientSecret);
    if (!data) return;

    const { paymentIntent } = data;

    await processPaymentIntent(paymentIntent);
  }, CHECK_INTERVAL);

  const processPaymentIntent = useCallback(
    async (paymentIntent?: PaymentIntent) => {
      if (!paymentIntent) {
        setPaymentIntentStatus('error');
        setProcessingPayment(false);
        return;
      }

      switch (paymentIntent.status) {
        case 'succeeded':
          try {
            setPaymentIntentStatus('succeeded');
            await onPaymentSuccess?.(paymentIntent);
            setProcessingPayment(false);
          } catch {
            // Safeguard in case anything fails after payment is successful
            setErrorMessage(
              'Payment was successful but there was an error performing requested actions after completion. Please contact support.'
            );
            setProcessingPayment(false);
            setPaymentIntentStatus('error');
          }
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

    return () => {
      if (!processingPayment) {
        paymentIntentProcessor.stop();
      }
    };
  }, [processingPayment, paymentIntentProcessor.active]);

  const onConfirmPayment = async (paymentMethodId?: string) => {
    if (!stripe || !(elements || paymentMethodId)) {
      // Stripe.js hasn't yet loaded.
      // Make sure to disable form submission until Stripe.js has loaded.
      return;
    }

    setProcessingPayment(true);
    retries.current = 0;

    const { error, paymentIntent } = paymentMethodId
      ? await stripe.confirmPayment({
          clientSecret,
          redirect: 'if_required',
          confirmParams: {
            // Make sure to change this to your payment completion page
            return_url: `${env.NEXT_PUBLIC_BASE_URL}/purchase/buzz`,
            payment_method: paymentMethodId,
            expand: ['payment_method'],
          },
        })
      : elements
      ? await stripe.confirmPayment({
          elements,
          redirect: 'if_required',
          confirmParams: {
            // Make sure to change this to your payment completion page
            return_url: `${env.NEXT_PUBLIC_BASE_URL}/purchase/buzz`,
            expand: ['payment_method'],
          },
        })
      : { error: { message: 'Something went wrong.' }, paymentIntent: undefined };

    if (error) {
      if (error.type === 'card_error' || error.type === 'validation_error') {
        setPaymentIntentStatus(error.type);
      } else {
        setPaymentIntentStatus('error');
      }

      setErrorMessage(error.message ?? 'Something went wrong.');
      setProcessingPayment(false);

      return;
    }

    processPaymentIntent(paymentIntent);

    return paymentIntent as PaymentIntent & { payment_method: PaymentMethod | undefined };
  };

  return {
    errorMessage,
    onConfirmPayment,
    processingPayment,
    paymentIntentStatus,
  };
};
