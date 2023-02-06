import { cloneElement } from 'react';
import { getClientStripe } from '~/utils/get-client-stripe';
import { trpc } from '~/utils/trpc';
import Router from 'next/router';

export function DonateButton({ children }: { children: React.ReactElement }) {
  const { mutate, isLoading } = trpc.stripe.createDonateSession.useMutation({
    async onSuccess({ sessionId, url }) {
      if (url) Router.push(url);
      else {
        const stripe = await getClientStripe();
        await stripe.redirectToCheckout({ sessionId });
      }
    },
  });

  const handleClick = () => mutate({ returnUrl: location.href });

  return cloneElement(children, { onClick: handleClick, loading: isLoading });
}
