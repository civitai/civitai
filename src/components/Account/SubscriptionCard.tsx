import { Button, Card, Stack, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function SubscriptionCard() {
  const router = useRouter();
  const { mutate } = trpc.stripe.createManageSubscriptionSession.useMutation();
  const currentUser = useCurrentUser();
  console.log({ currentUser });

  const handleClick = () => {
    mutate(undefined, {
      onSuccess: (data) => {
        router.push(data.url);
      },
    });
  };

  return (
    <Card withBorder>
      <Stack>
        <Title id="manage-subscription" order={2}>
          Manage Subscription
        </Title>
        <Button onClick={handleClick}>Manage Subscription</Button>
      </Stack>
    </Card>
  );
}
