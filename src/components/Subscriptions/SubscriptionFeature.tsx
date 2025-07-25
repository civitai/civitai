import { Group, Paper, Stack, Text } from '@mantine/core';
import { capitalize } from 'lodash-es';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BuzzAccountType } from '~/server/schema/buzz.schema';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { getBuzzBulkMultiplier } from '~/server/utils/buzz-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import styles from './SubscriptionFeature.module.css';

export const SubscriptionFeature = ({
  title,
  subtitle,
}: {
  title: string | React.ReactNode;
  subtitle: string | ((className: string) => React.ReactNode);
  buzzType?: BuzzAccountType | 'yellow' | 'red';
}) => {
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();
  const { subscription } = useActiveSubscription();

  if (!currentUser || !featureFlags.membershipsV2) {
    return null;
  }

  const { image } = !subscription
    ? { image: null }
    : getPlanDetails(subscription.product, featureFlags);

  return (
    <Paper className={styles.paper} py="xs">
      <Group wrap="nowrap">
        {image && <EdgeMedia src={image} style={{ width: 50 }} />}
        <Stack gap={2}>
          <Text className="text-base font-semibold text-black dark:text-white">{title}</Text>
          {typeof subtitle === 'string' ? (
            <Text className="text-sm" lh={1.2}>
              {subtitle}
            </Text>
          ) : (
            subtitle('text-sm')
          )}
        </Stack>
      </Group>
    </Paper>
  );
};

export const BuzzPurchaseMultiplierFeature = ({
  buzzAmount,
  buzzType = 'yellow',
}: {
  buzzAmount: number;
  buzzType?: BuzzAccountType | 'yellow' | 'red';
}) => {
  const { subscription } = useActiveSubscription();
  const { multipliers, multipliersLoading } = useUserMultipliers();
  const purchasesMultiplier = multipliers.purchasesMultiplier ?? 1;
  const { mainBuzzAdded, blueBuzzAdded, bulkBuzzMultiplier } = getBuzzBulkMultiplier({
    buzzAmount,
    purchasesMultiplier,
  });

  if (multipliersLoading || ((!subscription || mainBuzzAdded === 0) && blueBuzzAdded === 0)) {
    return null;
  }

  const metadata = subscription?.product.metadata as SubscriptionProductMetadata;

  return (
    <SubscriptionFeature
      buzzType={buzzType}
      title={
        <Group wrap="nowrap" gap={2}>
          <CurrencyIcon type={buzzType} size={20} />
          <span>
            {numberWithCommas(Math.floor(mainBuzzAdded + blueBuzzAdded))} Bonus Buzz Free!
          </span>
        </Group>
      }
      subtitle={(className: string) => (
        <Stack gap="sm">
          <Text className={className}>
            {subscription
              ? `As a ${capitalize(metadata.tier)} member you get ${Math.round(
                  (purchasesMultiplier - 1) * 100
                )}% bonus Buzz on each purchase (${numberWithCommas(mainBuzzAdded)} ${
                  capitalize(buzzType) ?? 'Yellow'
                } Buzz). ${
                  blueBuzzAdded > 0
                    ? `Buying in Bulk will also add ${numberWithCommas(
                        blueBuzzAdded
                      )} Extra Blue Buzz!`
                    : ''
                } `
              : `Buying in Bulk will also add ${numberWithCommas(blueBuzzAdded)} Extra Blue Buzz!`}
          </Text>

          {bulkBuzzMultiplier > 1 && (
            <Text className={className}>
              You will also get some extra love with your purchase! A few cosmetics will be added to
              your account for free!
            </Text>
          )}
        </Stack>
      )}
    />
  );
};
