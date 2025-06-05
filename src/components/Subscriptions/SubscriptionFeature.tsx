import { createStyles, Group, Paper, Stack, Text } from '@mantine/core';
import { capitalize } from 'lodash-es';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { getBuzzBulkMultiplier } from '~/server/utils/buzz-helpers';
import { numberWithCommas } from '~/utils/number-helpers';

const useStyles = createStyles((theme) => ({
  card: {
    backgroundColor: theme.fn.rgba(theme.colors.yellow[6], 0.2),
    border: `1px solid ${theme.fn.rgba(theme.colors.yellow[6], 0.3)}`,
    width: '100%',
    maxHeight: '100%',
    margin: 0,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    display: 'flex',
  },
  title: {
    color: theme.colorScheme === 'dark' ? theme.white : theme.black,
    fontWeight: 600,
    fontSize: 16,
  },
  subtitle: {
    fontSize: 14,
  },
}));

export const SubscriptionFeature = ({
  title,
  subtitle,
}: {
  title: string | React.ReactNode;
  subtitle: string | ((className: string) => React.ReactNode);
}) => {
  const { classes } = useStyles();
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
    <Paper className={classes.card} py="xs">
      <Group noWrap>
        {image && <EdgeMedia src={image} style={{ width: 50 }} />}
        <Stack spacing={2}>
          <Text className={classes.title}>{title}</Text>
          {typeof subtitle === 'string' ? (
            <Text className={classes.subtitle} lh={1.2}>
              {subtitle}
            </Text>
          ) : (
            subtitle(classes.subtitle)
          )}
        </Stack>
      </Group>
    </Paper>
  );
};

export const BuzzPurchaseMultiplierFeature = ({ buzzAmount }: { buzzAmount: number }) => {
  const { subscription } = useActiveSubscription();
  const { multipliers, multipliersLoading } = useUserMultipliers();
  const purchasesMultiplier = multipliers.purchasesMultiplier ?? 1;
  const { yellowBuzzAdded, blueBuzzAdded, bulkBuzzMultiplier } = getBuzzBulkMultiplier({
    buzzAmount,
    purchasesMultiplier,
  });

  if (multipliersLoading || ((!subscription || yellowBuzzAdded === 0) && blueBuzzAdded === 0)) {
    return null;
  }

  const metadata = subscription?.product.metadata as SubscriptionProductMetadata;

  return (
    <SubscriptionFeature
      title={
        <Group noWrap spacing={2}>
          <CurrencyIcon size={20} />
          <span>
            {numberWithCommas(Math.floor(yellowBuzzAdded + blueBuzzAdded))} Bonus Buzz Free!
          </span>
        </Group>
      }
      subtitle={(className: string) => (
        <Stack spacing="sm">
          <Text className={className}>
            {subscription
              ? `As a ${capitalize(metadata.tier)} member you get ${Math.round(
                  (purchasesMultiplier - 1) * 100
                )}% bonus Buzz on each purchase (${numberWithCommas(
                  yellowBuzzAdded
                )} Yellow Buzz). ${
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
