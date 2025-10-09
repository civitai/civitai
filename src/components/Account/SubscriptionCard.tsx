import { Button, Card, Stack, Center, Loader, Title, Text, Group, Box, Alert } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconSettings, IconExternalLink } from '@tabler/icons-react';
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

export function SubscriptionCard() {
  const [mainBuzzType] = useAvailableBuzz();
  const { subscription, subscriptionLoading } = useActiveSubscription({
    buzzType: mainBuzzType,
  });
  const features = useFeatureFlags();
  const { classNames: greenClassNames } = useBuzzCurrencyConfig('green');
  const price = subscription?.price;
  const product = subscription?.product;
  const { image } = subscription
    ? getPlanDetails(subscription?.product, features)
    : { image: null };

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
                <Text size="sm" c={subscription.cancelAt ? 'red' : 'dimmed'}>
                  {subscription.cancelAt || isCivitaiProvider ? 'Ends' : 'Renews'}{' '}
                  {formatDate(subscription.currentPeriodEnd)}
                </Text>
              </Stack>
            </Group>
            {!subscription.cancelAt && !showRedirectMessage && !isCivitaiProvider && (
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
