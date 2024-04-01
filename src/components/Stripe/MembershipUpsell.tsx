import {
  Paper,
  createStyles,
  Text,
  Stack,
  Group,
  Button,
  Anchor,
  Badge,
  Alert,
} from '@mantine/core';
import { IconBolt, IconCheck, IconDiscount2 } from '@tabler/icons-react';
import { capitalize } from 'lodash';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Stripe/PlanCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ProductMetadata } from '~/server/schema/stripe.schema';
import { formatPriceForDisplay, numberWithCommas } from '~/utils/number-helpers';
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
    fontSize: 24,
    fontWeight: 600,
  },
  subtitle: {
    fontSize: 18,
    fontWeight: 500,
  },
  listItem: {
    color: `${theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.black} !important`,
    fontSize: 16,

    '.mantine-Text-root': {
      color: `${theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.black} !important`,
    },
  },
}));

export const MembershipUpsell = ({ buzzAmount }: { buzzAmount: number }) => {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();
  const { data: products = [], isLoading: productsLoading } = trpc.stripe.getPlans.useQuery(
    undefined,
    {
      enabled: !!currentUser,
    }
  );
  const { data: subscription, isLoading: subscriptionLoading } =
    trpc.stripe.getUserSubscription.useQuery(undefined, {
      enabled: !!currentUser,
    });
  const { multipliers, multipliersLoading } = useUserMultipliers();
  const isMember = currentUser?.isMember;
  const purchasesMultiplier = multipliers.purchasesMultiplier ?? 1;

  if (productsLoading || subscriptionLoading || !currentUser || multipliersLoading) {
    return null;
  }

  const targetPlan = products.find((product) => {
    const metadata = (product?.metadata ?? {}) as ProductMetadata;
    return metadata.monthlyBuzz >= buzzAmount;
  });

  if (!targetPlan) {
    return null;
  }

  if (
    subscription &&
    constants.memberships.tierOrder.indexOf(subscription.product.metadata.tier) >=
      constants.memberships.tierOrder.indexOf(targetPlan.metadata.tier)
  ) {
    return (
      <Stack>
        {purchasesMultiplier > 1 && (
          <Alert color="yellow" title="Your membership gets you more!" icon={<IconBolt />}>
            <Text>
              Thanks to your membership you will get an extra{' '}
              <Text component="span" weight="bold">
                {numberWithCommas(Math.floor(buzzAmount * purchasesMultiplier - buzzAmount))} Buzz
              </Text>{' '}
              for a total of{' '}
              <Text component="span" weight="bold">
                {numberWithCommas(Math.floor(buzzAmount * purchasesMultiplier))} Buzz
              </Text>{' '}
              for the same price!
            </Text>
          </Alert>
        )}
      </Stack>
    );
  }

  const { image, benefits } = getPlanDetails(targetPlan, featureFlags);
  const targetTier = targetPlan.metadata.tier ?? 'free';
  const monthlyBuzz = targetPlan.metadata.monthlyBuzz ?? 0;
  const unitAmount = targetPlan.price.unitAmount ?? 0;

  return (
    <Stack>
      <Paper className={classes.card}>
        <Stack h="100%">
          <Badge variant="light" size="sm" color="green" ml="auto">
            <Group spacing={4}>
              <IconDiscount2 size={13} />
              <Text>SAVE MORE</Text>
            </Group>
          </Badge>
          {image && <EdgeMedia src={image} width={80} />}
          <Stack spacing={0}>
            <Text className={classes.title}>{capitalize(targetTier)} membership</Text>
            <Text color="yellow.7" className={classes.subtitle}>
              ${formatPriceForDisplay(unitAmount)} can get you a lot more than{' '}
              {numberWithCommas(monthlyBuzz)} Buzz:
            </Text>
          </Stack>
          <Stack spacing={4}>
            {benefits.map((benefit, index) => (
              <Group spacing="xs" key={index} noWrap>
                <IconCheck size={18} />
                <Text key={index} className={classes.listItem} color="faded">
                  {benefit.content}
                </Text>
              </Group>
            ))}
          </Stack>
          <div>
            <Button radius="xl" size="md">
              Get {capitalize(targetTier)} - ${formatPriceForDisplay(unitAmount)}
              /Month
            </Button>
          </div>
          <Text mt="auto" size="sm">
            Cancel for free anytime. <Anchor href="/pricing">Learn more</Anchor>
          </Text>
        </Stack>
      </Paper>
      {purchasesMultiplier > 1 && (
        <Alert
          color="yellow"
          title="Your membership gets you more!"
          radius="md"
          icon={<IconBolt />}
        >
          <Text>
            Thanks to your membership you will get an extra{' '}
            <Text component="span" weight="bold">
              {numberWithCommas(Math.floor(buzzAmount * purchasesMultiplier - buzzAmount))} Buzz
            </Text>{' '}
            for a total of{' '}
            <Text component="span" weight="bold">
              {numberWithCommas(Math.floor(buzzAmount * purchasesMultiplier))} Buzz
            </Text>{' '}
            for the same price!
          </Text>
        </Alert>
      )}
    </Stack>
  );
};
