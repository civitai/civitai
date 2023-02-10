import { useIsMutating } from '@tanstack/react-query';
import { cloneElement } from 'react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { getClientStripe } from '~/utils/get-client-stripe';
import { trpc } from '~/utils/trpc';
import Router from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Button, Stack, Text } from '@mantine/core';
import { openContextModal } from '@mantine/modals';

export function SubscribeButton({
  children,
  priceId,
}: {
  children: React.ReactElement;
  priceId: string;
}) {
  const currentUser = useCurrentUser();
  const mutateCount = useIsMutating();
  const { mutate, isLoading } = trpc.stripe.createSubscriptionSession.useMutation({
    async onSuccess({ sessionId, url }) {
      if (url) Router.push(url);
      else if (sessionId) {
        const stripe = await getClientStripe();
        await stripe.redirectToCheckout({ sessionId });
      }
    },
  });

  const handleClick = () => mutate({ priceId });

  const handleAddEmail = () => {
    openContextModal({
      modal: 'onboarding',
      title: 'Your Account',
      withCloseButton: false,
      closeOnClickOutside: false,
      closeOnEscape: false,
      innerProps: {},
    });
  };

  if (currentUser && !currentUser.email)
    return (
      <Button onClick={handleAddEmail} sx={{ height: 50 }}>
        <Stack align="center" spacing={0}>
          <Text align="center" sx={{ lineHeight: 1.1 }}>
            Subscribe
          </Text>
          <Text align="center" size="xs" sx={{ color: 'rgba(255,255,255,.7)' }}>
            *Email Required. Click here to set it.
          </Text>
        </Stack>
      </Button>
    );

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
