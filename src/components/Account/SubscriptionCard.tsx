import { Button, Card, Stack, Center, Loader, Title, Text, Group, Box } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconSettings } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Subscriptions/PlanCard';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatDate } from '~/utils/date-helpers';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { CancelMembershipAction } from '~/components/Subscriptions/CancelMembershipAction';

export function SubscriptionCard() {
  const { subscription, subscriptionLoading } = useActiveSubscription();
  const features = useFeatureFlags();
  const price = subscription?.price;
  const product = subscription?.product;
  const { image } = subscription
    ? getPlanDetails(subscription?.product, features)
    : { image: null };

  return (
    <Card withBorder>
      <Stack>
        <Group position="apart">
          <Title id="manage-subscription" order={2}>
            Membership
          </Title>
          <Button
            compact
            radius="xl"
            color="gray"
            rightIcon={<IconSettings size={16} />}
            component={Link}
            href="/user/membership"
          >
            Manage
          </Button>
        </Group>
        {subscriptionLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : subscription ? (
          <>
            <Group position="apart">
              <Group noWrap>
                {image && (
                  <Center>
                    <Box w={40}>
                      <EdgeMedia src={image} />
                    </Box>
                  </Center>
                )}
                {product && <Text>{product.name}</Text>}
              </Group>
              <Stack spacing={0}>
                {price && (
                  <Text>
                    {getStripeCurrencyDisplay(price.unitAmount, price.currency) +
                      ' ' +
                      price.currency.toUpperCase() +
                      '/' +
                      shortenPlanInterval(price.interval)}
                  </Text>
                )}
                <Text size="sm" color={subscription.cancelAt ? 'red' : 'dimmed'}>
                  {subscription.cancelAt ? 'Ends' : 'Renews'}{' '}
                  {formatDate(subscription.currentPeriodEnd)}
                </Text>
              </Stack>
            </Group>
            {!subscription.cancelAt && (
              <CancelMembershipAction
                variant="button"
                buttonProps={{ color: 'red', variant: 'outline', fullWidth: true }}
              />
            )}
          </>
        ) : null}
      </Stack>
    </Card>
  );
}
