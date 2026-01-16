import { Button, Card, Stack, Center, Loader, Title, Text, Group, Box } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconAlertTriangle, IconSettings } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatDate } from '~/utils/date-helpers';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { CancelMembershipAction } from '~/components/Subscriptions/CancelMembershipAction';
import { env } from '~/env/client';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { useNextBuzzDelivery } from '~/hooks/useNextBuzzDelivery';
import { numberWithCommas } from '~/utils/number-helpers';

export function SubscriptionCard() {
  const [mainBuzzType] = useAvailableBuzz();
  const { subscription, subscriptionLoading } = useActiveSubscription({
    buzzType: mainBuzzType,
    checkWhenInBadState: true,
  });
  const features = useFeatureFlags();
  const { classNames: greenClassNames } = useBuzzCurrencyConfig('green');
  const price = subscription?.price;
  const product = subscription?.product;
  const { image } = subscription
    ? getPlanDetails(subscription?.product, features)
    : { image: null };

  // Calculate next buzz delivery
  const { nextBuzzDelivery, buzzAmount, shouldShow } = useNextBuzzDelivery({
    buzzType: mainBuzzType,
  });

  // Don't show the card if there's no subscription
  if (!subscriptionLoading && !subscription) {
    return null;
  }

  // If user has subscription but is on red environment, show redirect message
  const isCivitaiProvider = subscription?.product?.provider === PaymentProvider.Civitai;

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Title id="manage-subscription" order={2}>
            Membership
          </Title>
          <Button
            size="compact-sm"
            radius="xl"
            color="gray"
            rightSection={<IconSettings size={16} />}
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
            {subscription.isBadState && (
              <AlertWithIcon
                color="red"
                iconColor="red"
                icon={<IconAlertTriangle size={16} />}
                py={8}
              >
                <Text size="sm" lh={1.2}>
                  There&apos;s an issue with your membership.{' '}
                  <Text component={Link} href="/user/membership" c="red" td="underline" inherit>
                    Fix it now
                  </Text>
                </Text>
              </AlertWithIcon>
            )}
            <Group justify="space-between">
              <Group wrap="nowrap">
                {image && (
                  <Center>
                    <Box w={40}>
                      <EdgeMedia src={image} />
                    </Box>
                  </Center>
                )}
                {product && <Text>{product.name}</Text>}
              </Group>
              <Stack gap={0}>
                {price && (
                  <Text>
                    {getStripeCurrencyDisplay(price.unitAmount, price.currency) +
                      ' ' +
                      price.currency.toUpperCase() +
                      '/' +
                      shortenPlanInterval(price.interval)}
                  </Text>
                )}
                <Text size="sm" c={subscription.cancelAt || subscription.isBadState ? 'red' : 'dimmed'}>
                  {subscription.isBadState
                    ? 'Payment failed'
                    : subscription.cancelAt || isCivitaiProvider
                      ? 'Ends'
                      : 'Renews'}{' '}
                  {!subscription.isBadState && formatDate(subscription.currentPeriodEnd)}
                </Text>
              </Stack>
            </Group>
            {shouldShow && nextBuzzDelivery && buzzAmount && !subscription.isBadState && (
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" c="dimmed">
                  Next Buzz Delivery:
                </Text>
                <Text size="sm" fw={500}>
                  {formatDate(nextBuzzDelivery.toDate())}
                </Text>
                <Text size="xs" c="dimmed">
                  ({numberWithCommas(buzzAmount)} Buzz)
                </Text>
              </Group>
            )}
            {!subscription.cancelAt && !isCivitaiProvider && !subscription.isBadState && (
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
