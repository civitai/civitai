import { Button, Card, Stack, Title, Center, Loader, Text } from '@mantine/core';
import Router from 'next/router';
import { trpc } from '~/utils/trpc';

export function SubscriptionCard() {
  const { data, isLoading } = trpc.stripe.getUserSubscription.useQuery();
  const { mutate } = trpc.stripe.createManageSubscriptionSession.useMutation();

  const handleClick = () => {
    mutate(undefined, {
      onSuccess: (data) => {
        Router.push(data.url);
      },
    });
  };

  return (
    <Card withBorder>
      <Stack>
        <Title id="manage-subscription" order={2}>
          Manage Subscription
        </Title>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : data ? (
          <>
            <Title order={2}>{data.product.name}</Title>
            <Text>
              ${data.price.unitAmount / 100} / {data.price.interval}
            </Text>
          </>
        ) : null}

        <Button onClick={handleClick}>Manage Subscription</Button>
      </Stack>
    </Card>
  );
}
