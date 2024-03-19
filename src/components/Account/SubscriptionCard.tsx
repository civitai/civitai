import { Button, Card, Stack, Center, Loader, Title, Text, Group } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconRotateClockwise, IconSettings } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CancelMembershipFeedbackModal } from '~/components/Stripe/MembershipChangePrevention';
import { getPlanDetails } from '~/components/Stripe/PlanCard';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { formatDate } from '~/utils/date-helpers';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function SubscriptionCard() {
  const { data, isLoading } = trpc.stripe.getUserSubscription.useQuery();
  const features = useFeatureFlags();
  const price = data?.price;
  const product = data?.product;
  const { image } = data ? getPlanDetails(data?.product, features) : { image: null };

  return (
    <Card withBorder>
      <Stack>
        <Group position="apart">
          <Title id="manage-subscription" order={2}>
            Membership
          </Title>
          {data?.canceledAt ? (
            <SubscribeButton priceId={data?.price.id}>
              <Button compact radius="xl" rightIcon={<IconRotateClockwise size={16} />}>
                Resume
              </Button>
            </SubscribeButton>
          ) : (
            <Button
              compact
              radius="xl"
              color="gray"
              rightIcon={<IconSettings size={16} />}
              component={NextLink}
              href="/user/membership"
            >
              Manage
            </Button>
          )}
        </Group>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : data ? (
          <Group position="apart">
            <Group noWrap>
              {image && (
                <Center>
                  <EdgeMedia src={image} width={40} />
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
                    shortenPlanInterval(price.interval, price.intervalCount)}
                </Text>
              )}
              <Text size="sm" color="dimmed">
                {data.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {formatDate(data.currentPeriodEnd)}
              </Text>
            </Stack>
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}
