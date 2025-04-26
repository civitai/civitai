import {
  Paper,
  Text,
  Stack,
  Group,
  Button,
  Anchor,
  Badge,
  Loader,
  Center,
  Box,
} from '@mantine/core';
import { createStyles } from '@mantine/styles';
import { IconCheck, IconDiscountCheck } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Subscriptions/PlanCard';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { formatPriceForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { MembershipUpgradeModal } from '~/components/Stripe/MembershipChangePrevention';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { styles } from './MembershipUpsell.styles';

const useStyles = createStyles(styles);

export const MembershipUpsell = ({ buzzAmount }: { buzzAmount: number }) => {
  const { classes } = useStyles();
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();
  const { data: products = [], isLoading: productsLoading } = trpc.subscriptions.getPlans.useQuery(
    {},
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

  const subscriptionMetadata = subscription?.product?.metadata as SubscriptionProductMetadata;

  const targetPlan = products.find((product, index) => {
    const metadata = (product?.metadata ?? {
      monthlyBuzz: 0,
      tier: 'free',
    }) as SubscriptionProductMetadata;
    if (
      subscription &&
      subscriptionMetadata &&
      constants.memberships.tierOrder.indexOf(subscriptionMetadata.tier) >=
        constants.memberships.tierOrder.indexOf(metadata.tier)
    ) {
      return false;
    }

    return (metadata.monthlyBuzz ?? 0) >= buzzAmount || index === products.length - 1;
  });

  if (!targetPlan) {
    return null;
  }

  const metadata = (targetPlan.metadata ?? {}) as SubscriptionProductMetadata;
  const planMeta = getPlanDetails(targetPlan, featureFlags);
  const { image, benefits } = planMeta;

  const targetTier = metadata.tier ?? 'free';
  // const monthlyBuzz = metadata.monthlyBuzz ?? 0;
  const unitAmount = targetPlan.price.unitAmount ?? 0;
  const priceId = targetPlan.defaultPriceId ?? '';

  return (
    <Paper className={classes.card}>
      <Stack h="100%" w="100%">
        <Badge variant="light" size="lg" color="green" ml="auto" mb={-36} px={8}>
          <Group spacing={4}>
            <IconDiscountCheck size={18} />
            <Text tt="uppercase">Get More</Text>
          </Group>
        </Badge>
        {image && (
          <Box w={80}>
            <EdgeMedia src={image} />
          </Box>
        )}
        <Stack spacing={0}>
          <Text className={classes.title}>{capitalize(targetTier)} membership</Text>
          <Text color="yellow.7" className={classes.subtitle}>
            {subscription ? 'Upgrade to get even more perks:' : 'Get more with a membership:'}
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
          {subscription ? (
            <Button
              radius="xl"
              size="md"
              mt="sm"
              onClick={() => {
                dialogStore.trigger({
                  component: MembershipUpgradeModal,
                  props: {
                    priceId,
                    meta: planMeta,
                  },
                });
              }}
            >
              Upgrade - ${formatPriceForDisplay(unitAmount, undefined, { decimals: false })}
              /Month
            </Button>
          ) : (
            <SubscribeButton priceId={priceId}>
              <Button radius="xl" size="md" mt="sm">
                Get {capitalize(targetTier)} - $
                {formatPriceForDisplay(unitAmount, undefined, { decimals: false })}
                /Month
              </Button>
            </SubscribeButton>
          )}
        </div>
        <Text mt="auto" size="sm">
          Cancel for free anytime. <Anchor href="/pricing">Learn more</Anchor>
        </Text>
      </Stack>
    </Paper>
  );
};
