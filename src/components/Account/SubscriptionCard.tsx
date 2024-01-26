import { Button, Card, Stack, Center, Loader, Title, Text, Group, Code } from '@mantine/core';
import { IconRotateClockwise, IconSettings } from '@tabler/icons-react';
import { upperFirst } from 'lodash-es';
import {
  DescriptionTable,
  Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { ManageSubscriptionButton } from '~/components/Stripe/ManageSubscriptionButton';
import { PlanBenefitList } from '~/components/Stripe/PlanBenefitList';
import { planDetails } from '~/components/Stripe/PlanCard';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function SubscriptionCard() {
  const { data, isLoading } = trpc.stripe.getUserSubscription.useQuery();

  const details: DescriptionTableProps['items'] = [];
  let displayStatus = '';
  if (data) {
    const { status, price, product } = data;
    displayStatus = data.canceledAt ? 'canceled' : status;
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
              {getStripeCurrencyDisplay(price.unitAmount, price.currency) +
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
          {data?.canceledAt ? (
            <SubscribeButton priceId={data?.price.id}>
              <Button compact variant="outline" rightIcon={<IconRotateClockwise size={16} />}>
                Resume
              </Button>
            </SubscribeButton>
          ) : (
            <ManageSubscriptionButton>
              <Button compact variant="outline" rightIcon={<IconSettings size={16} />}>
                Manage
              </Button>
            </ManageSubscriptionButton>
          )}
        </Group>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : data ? (
          <DescriptionTable items={details} />
        ) : null}
        {displayStatus === 'active' && (
          <Stack>
            <Text size="md" weight={500}>
              Your Membership Includes
            </Text>
            <PlanBenefitList benefits={planDetails[0].benefits} />
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
