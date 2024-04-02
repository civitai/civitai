import {
  Paper,
  createStyles,
  Text,
  Stack,
  Group,
  Button,
  Anchor,
  Badge,
  Loader,
  Center,
} from '@mantine/core';
import { IconCheck, IconDiscount2 } from '@tabler/icons-react';
import { capitalize } from 'lodash';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Stripe/PlanCard';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
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
    height: '100%',
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

  const { subscription, subscriptionLoading } = useActiveSubscription();

  if (productsLoading || subscriptionLoading || !currentUser) {
    return (
      <Paper className={classes.card}>
        <Center w="100%">
          <Loader variant="bars" />
        </Center>
      </Paper>
    );
  }

  const subscriptionMetadata = subscription?.product?.metadata as ProductMetadata;

  const targetPlan = products.find((product) => {
    const metadata = (product?.metadata ?? { monthlyBuzz: 0, tier: 'free' }) as ProductMetadata;
    if (
      subscription &&
      subscriptionMetadata &&
      constants.memberships.tierOrder.indexOf(subscriptionMetadata.tier) >=
        constants.memberships.tierOrder.indexOf(metadata.tier)
    ) {
      return false;
    }

    return (metadata.monthlyBuzz ?? 0) >= buzzAmount;
  });

  if (!targetPlan) {
    return null;
  }

  const metadata = (targetPlan.metadata ?? {}) as ProductMetadata;
  const { image, benefits } = getPlanDetails(targetPlan, featureFlags);

  const targetTier = metadata.tier ?? 'free';
  const monthlyBuzz = metadata.monthlyBuzz ?? 0;
  const unitAmount = targetPlan.price.unitAmount ?? 0;
  const priceId = targetPlan.defaultPriceId ?? '';

  return (
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
          <SubscribeButton priceId={priceId}>
            <Button radius="xl" size="md">
              Get {capitalize(targetTier)} - ${formatPriceForDisplay(unitAmount)}
              /Month
            </Button>
          </SubscribeButton>
        </div>
        <Text mt="auto" size="sm">
          Cancel for free anytime. <Anchor href="/pricing">Learn more</Anchor>
        </Text>
      </Stack>
    </Paper>
  );
};
