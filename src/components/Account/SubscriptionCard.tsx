import { Button, Card, Stack, Center, Loader, Title } from '@mantine/core';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';
import { PlanDetails } from '~/components/Stripe/PlanDetails';
import { trpc } from '~/utils/trpc';

export function SubscriptionCard() {
  const { data, isLoading } = trpc.stripe.getUserSubscription.useQuery();

  return (
    <Card withBorder>
      {/* <Card.Section>
        <Text>Your subscription</Text>
      </Card.Section> */}
      <Stack>
        <Title id="manage-subscription" order={2}>
          Manage Subscription
        </Title>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : data ? (
          <PlanDetails
            name={data.product.name}
            description={data.product.description}
            unitAmount={data.price.unitAmount}
            currency={data.price.currency}
            interval={data.price.interval}
          />
        ) : null}

        <Center>
          <ManageSubscriptionButton>
            <Button>Manage Subscription</Button>
          </ManageSubscriptionButton>
        </Center>
      </Stack>
    </Card>
  );
}
