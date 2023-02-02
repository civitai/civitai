import { Button, Card, Stack, Title, Center, Loader, Text, Group } from '@mantine/core';
import Router from 'next/router';
import { formatDate } from '~/utils/date-helpers';
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

  // const renewsAt = <Text>{formatDate(data.currentPeriodEnd)}</Text>;
  // const endsAt = <Text>{formatDate(data.cancelAt)}</Text>;
  // const endedAt = <Text>{formatDate(data.endedAt)}</Text>;

  return (
    <Card withBorder>
      {/* <Card.Section>
        <Text>Your subscription</Text>
      </Card.Section> */}
      <Stack>
        {/* <Title id="manage-subscription" order={2}>
          Manage Subscription
        </Title> */}
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : data ? (
          <>
            <Stack spacing={0}>
              <Title order={2} align="center">
                {data.product.name}
              </Title>
              <Text align="center">
                ${data.price.unitAmount / 100} {data.price.currency.toUpperCase()} /{' '}
                {data.price.interval}
              </Text>
            </Stack>
            {data.product.description && <Text>{data.product.description}</Text>}
          </>
        ) : null}

        <Center>
          <Button onClick={handleClick}>Manage Subscription</Button>
        </Center>
      </Stack>
    </Card>
  );
}
