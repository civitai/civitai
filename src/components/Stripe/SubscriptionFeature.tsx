import { Paper, createStyles, Text, Stack, Group } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { capitalize } from 'lodash';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
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
  subtitle: string;
}) => {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();
  const { subscription } = useActiveSubscription();

  if (!currentUser || !subscription || !featureFlags.membershipsV2) {
    return null;
  }

  const { image } = getPlanDetails(subscription.product, featureFlags);

  return (
    <Paper className={classes.card} py="xs">
      <Group noWrap>
        {image && <EdgeMedia src={image} style={{ width: 50 }} />}
        <Stack spacing={2}>
          <Text className={classes.title}>{title}</Text>
          <Text className={classes.subtitle} lh={1.2}>
            {subtitle}
          </Text>
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

  if (multipliersLoading || !subscription || purchasesMultiplier == 1) {
    return null;
  }

  const metadata = subscription.product.metadata as ProductMetadata;

  return (
    <SubscriptionFeature
      title={
        <Group noWrap spacing={2}>
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
      ).toFixed(0)}% bonus buzz on each purchase.`}
    />
  );
};
