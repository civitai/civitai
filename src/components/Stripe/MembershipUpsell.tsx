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
  Box,
} from '@mantine/core';
import { IconCheck, IconDiscountCheck } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { formatPriceForDisplay, numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { MembershipUpgradeModal } from '~/components/Stripe/MembershipChangePrevention';
import { dialogStore } from '~/components/Dialog/dialogStore';

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
  const features = useFeatureFlags();
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
  const planMeta = getPlanDetails(targetPlan, features);
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
              disabled={features.disablePayments}
              onClick={() => {
                dialogStore.trigger({
                  component: MembershipUpgradeModal,
                  props: {
                    priceId,
                    meta: planMeta,
                    price: {
                      id: priceId,
                      interval: 'month', // All our default plans are monthly
                    },
                  },
                });
              }}
            >
              Upgrade - ${formatPriceForDisplay(unitAmount, undefined, { decimals: false })}
              /Month
            </Button>
          ) : (
            <SubscribeButton priceId={priceId} disabled={features.disablePayments}>
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
