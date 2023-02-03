import { cloneElement } from 'react';
import { trpc } from '~/utils/trpc';
import Router from 'next/router';

export function ManageSubscriptionButton({ children }: { children: React.ReactElement }) {
  const { mutate, isLoading } = trpc.stripe.createManageSubscriptionSession.useMutation();

  const handleClick = () => {
    mutate(undefined, {
      onSuccess: (data) => {
        Router.push(data.url);
      },
    });
  };

  return cloneElement(children, { onClick: handleClick, loading: isLoading });
}
