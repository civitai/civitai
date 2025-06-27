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

export function SubscriptionCard() {
  const { subscription, subscriptionLoading } = useActiveSubscription();
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
  const showRedirectMessage = !features.isGreen && subscription;

  const handleRedirectToGreen = () => {
    window.open(
      `//${env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN}/user/membership?sync-account=blue`,
      '_blank',
      'noreferrer'
    );
  };

  return (
    <Card withBorder>
      <Stack>
        <Group justify="space-between">
          <Title id="manage-subscription" order={2}>
            Membership
          </Title>
          {showRedirectMessage ? (
            <Button
              size="compact-sm"
              radius="xl"
              rightSection={<IconExternalLink size={16} />}
              onClick={handleRedirectToGreen}
              className={`${greenClassNames?.btn} px-2 py-1 text-xs`}
            >
              Manage on Green
            </Button>
          ) : (
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
          )}
        </Group>
        {subscriptionLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : subscription ? (
          <>
            {showRedirectMessage && (
              <Alert color="blue" variant="light">
                <Text size="sm">
                  Your membership needs to be managed on Civitai Green. Click &quot;Manage on
                  Green&quot; to open the management page in a new window.
                </Text>
              </Alert>
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
                <Text size="sm" c={subscription.cancelAt ? 'red' : 'dimmed'}>
                  {subscription.cancelAt ? 'Ends' : 'Renews'}{' '}
                  {formatDate(subscription.currentPeriodEnd)}
                </Text>
              </Stack>
            </Group>
            {!subscription.cancelAt && !showRedirectMessage && (
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
