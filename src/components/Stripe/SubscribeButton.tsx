import { useIsMutating } from '@tanstack/react-query';
import { cloneElement } from 'react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { getClientStripe } from '~/utils/get-client-stripe';
import { trpc } from '~/utils/trpc';
import Router from 'next/router';

export function SubscribeButton({
  children,
  priceId,
}: {
  children: React.ReactElement;
  priceId: string;
}) {
  const mutateCount = useIsMutating();
  const { mutate, isLoading } = trpc.stripe.createSubscriptionSession.useMutation({
    async onSuccess({ sessionId, url }) {
      if (url) Router.push(url);
      else {
        const stripe = await getClientStripe();
        await stripe.redirectToCheckout({ sessionId });
      }
    },
  });

  const handleClick = () => mutate({ priceId });

  return (
    <LoginPopover>
      {cloneElement(children, {
        onClick: handleClick,
        loading: isLoading,
        disabled: !isLoading && mutateCount > 0,
      })}
    </LoginPopover>
  );
}
