import { Group, Paper, Stack, Text } from '@mantine/core';
import { capitalize } from 'lodash-es';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { getPlanDetails } from '~/components/Subscriptions/PlanCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { numberWithCommas } from '~/utils/number-helpers';

export const SubscriptionFeature = ({
  title,
  subtitle,
}: {
  title: string | React.ReactNode;
  subtitle: string;
}) => {
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();
  const { subscription } = useActiveSubscription();

  if (!currentUser || !subscription || !featureFlags.membershipsV2) {
    return null;
  }

  const { image } = getPlanDetails(subscription.product, featureFlags);

  return (
    <Paper
      className="m-0 flex max-h-full w-full rounded-md border-yellow-6/30 bg-yellow-6/20 p-4"
      py="xs"
    >
      <Group wrap="nowrap">
        {image && <EdgeMedia src={image} style={{ width: 50 }} />}
        <Stack gap={2}>
          <Text className="text-base font-semibold text-black dark:text-white">{title}</Text>
          <Text className="text-sm" lh={1.2}>
            {subtitle}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
};

export const BuzzPurchaseMultiplierFeature = ({ buzzAmount }: { buzzAmount: number }) => {
  const { subscription } = useActiveSubscription();
  const { multipliers, multipliersLoading } = useUserMultipliers();
  const purchasesMultiplier = multipliers.purchasesMultiplier ?? 1;

  if (multipliersLoading || !subscription || purchasesMultiplier == 1) {
    return null;
  }

  const metadata = subscription.product.metadata as SubscriptionProductMetadata;

  return (
    <SubscriptionFeature
      title={
        <Group wrap="nowrap" gap={2}>
          <CurrencyIcon size={20} />
          <span>
            {numberWithCommas(Math.floor(buzzAmount * purchasesMultiplier - buzzAmount))} Bonus Buzz
            Free!
          </span>
        </Group>
      }
      subtitle={`As a ${capitalize(metadata.tier)} member you get ${(
        (purchasesMultiplier - 1) *
        100
      ).toFixed(0)}% bonus Buzz on each purchase.`}
    />
  );
};
