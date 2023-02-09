import { Button, Card, Stack, Center, Loader, Title, Text, Group, Code } from '@mantine/core';
import { IconSettings } from '@tabler/icons';
import { upperFirst } from 'lodash';
import {
  DescriptionTable,
  Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';
import { trpc } from '~/utils/trpc';

export function SubscriptionCard() {
  const { data, isLoading } = trpc.stripe.getUserSubscription.useQuery();

  const details: DescriptionTableProps['items'] = [];
  if (data) {
    const { status, price, product } = data;
    const displayStatus = data.canceledAt ? 'canceled' : status;
    details.push({
      label: 'Plan',
      value: product.name,
    });
    details.push({
      label: 'Status',
      value: (
        <Group align="flex-end" position="apart">
          <Text>{upperFirst(displayStatus)}</Text>
          <Text size="xs" color="dimmed">
            Since {(data.canceledAt ?? data.createdAt).toLocaleDateString()}
          </Text>
        </Group>
      ),
    });
    if (displayStatus === 'active') {
      details.push({
        label: 'Price',
        value: (
          <Group align="flex-end" position="apart">
            <Text>
              {'$' +
                price.unitAmount / 100 +
                ' ' +
                price.currency.toUpperCase() +
                ' per ' +
                price.interval}
            </Text>
            <Text size="xs" color="dimmed">
              Paid {data.currentPeriodStart.toLocaleDateString()}
            </Text>
          </Group>
        ),
      });
    }

    details.push({
      label: data.cancelAtPeriodEnd ? 'Ends' : 'Renews',
      value: new Date(data.currentPeriodEnd).toLocaleDateString(),
    });
  }

  return (
    <Card withBorder>
      <Stack>
        <Group position="apart">
          <Title id="manage-subscription" order={2}>
            Membership
          </Title>
          <ManageSubscriptionButton>
            <Button compact variant="outline" rightIcon={<IconSettings size={16} />}>
              Manage
            </Button>
          </ManageSubscriptionButton>
        </Group>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : data ? (
          <DescriptionTable items={details} />
        ) : null}
      </Stack>
    </Card>
  );
}
