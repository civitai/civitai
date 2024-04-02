import { Paper, createStyles, Text, Stack, Group } from '@mantine/core';
import { capitalize } from 'lodash';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Stripe/PlanCard';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ProductMetadata } from '~/server/schema/stripe.schema';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const useStyles = createStyles((theme) => ({
  card: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
    width: '100%',
    maxHeight: '100%',
    margin: 0,
    padding: theme.spacing.md,
    borderRadius: theme.radius.md,
    display: 'flex',
  },
  title: {
    color: theme.colorScheme === 'dark' ? theme.white : theme.black,
    fontSize: 16,
  },
  subtitle: {
    fontSize: 14,
  },
}));

export const SubscriptionFeature = ({ title, subtitle }: { title: string; subtitle: string }) => {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();
  const { subscription } = useActiveSubscription();

  if (!currentUser || !subscription) {
    return null;
  }

  const { image } = getPlanDetails(subscription.product, featureFlags);

  return (
    <Paper className={classes.card}>
      <Group noWrap>
        {image && <EdgeMedia src={image} width={40} />}
        <Stack spacing={2}>
          <Text className={classes.title}>{title}</Text>
          <Text className={classes.subtitle}>{subtitle}</Text>
        </Stack>
      </Group>
    </Paper>
  );
};

export const BuzzPurchaseMultiplierFeature = ({ buzzAmount }: { buzzAmount: number }) => {
  const currentUser = useCurrentUser();
  const { subscription } = useActiveSubscription();
  const { multipliers, multipliersLoading } = useUserMultipliers();
  const purchasesMultiplier = multipliers.purchasesMultiplier ?? 1;

  if (multipliersLoading || !subscription) {
    return null;
  }

  const metadata = subscription.product.metadata as ProductMetadata;

  return (
    <SubscriptionFeature
      title={`${numberWithCommas(
        Math.floor(buzzAmount * purchasesMultiplier - buzzAmount)
      )} Buzz Free For You!`}
      subtitle={`${capitalize(metadata.tier)} members get ${(
        (purchasesMultiplier - 1) *
        100
      ).toFixed(0)}% extra buzz on each purchase`}
    />
  );
};
