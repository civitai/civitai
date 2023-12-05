import { useElements, useStripe } from '@stripe/react-stripe-js';
import { useState } from 'react';
import { env } from '~/env/client.mjs';

export const useStripePaymentMethodSetup = ({ redirectUrl }: { redirectUrl?: string }) => {
  const [processingSetup, setProcessingSetup] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const stripe = useStripe();
  const elements = useElements();

  const onConfirmSetup = async () => {
    if (!stripe || !elements) {
      // Stripe.js hasn't yet loaded.
      // Make sure to disable form submission until Stripe.js has loaded.
      return;
    }

    setProcessingSetup(true);

    const { error } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        // Make sure to change this to your payment completion page
        // TODO.stripePayments: change this to the actual return url. May not need to do anything but redirect.
        return_url: `${env.NEXT_PUBLIC_BASE_URL}${redirectUrl ?? '/user/account#payment-methods'}`,
        expand: ['payment_method'],
      },
    });

    if (error) {
      // This point will only be reached if there is an immediate error when
      // confirming the payment. Show error to your customer (for example, payment
      // details incomplete)
      setErrorMessage(error.message ?? 'Something went wrong.');
      setProcessingSetup(false);
    } else {
      // Your customer will be redirected to your `return_url`. For some payment
      // methods like iDEAL, your customer will be redirected to an intermediate
      // site first to authorize the payment, then redirected to the `return_url`.
    }
  };

  return {
    errorMessage,
    onConfirmSetup,
    processingSetup,
  };
};
