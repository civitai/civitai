import { Button, Card, Stack, Center, Loader, Title, Text, Group } from '@mantine/core';
import { IconRotateClockwise, IconSettings } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { CancelMembershipFeedbackModal } from '~/components/Stripe/MembershipChangePrevention';
import { getPlanDetails } from '~/components/Stripe/PlanCard';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
              <Button compact variant="outline" rightIcon={<IconRotateClockwise size={16} />}>
                Resume
              </Button>
            </SubscribeButton>
          ) : (
            <Button
              compact
              radius="xl"
              color="gray"
              rightIcon={<IconSettings size={16} />}
              onClick={() => {
                dialogStore.trigger({
                  component: CancelMembershipFeedbackModal,
                });
              }}
            >
              Cancel
            </Button>
          )}
        </Group>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : data ? (
          <Group position="apart">
            <Group>
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
                    shortenPlanInterval(price.interval)}
                </Text>
              )}
              <Text size="sm" color="dimmed">
                {data.cancelAtPeriodEnd ? 'Ends' : 'Renews'}{' '}
                {new Date(data.currentPeriodEnd).toLocaleDateString()}
              </Text>
            </Stack>
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}
