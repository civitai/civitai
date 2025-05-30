import type { ButtonProps, ThemeIconVariant } from '@mantine/core';
import {
  Box,
  Button,
  Card,
  Center,
  createStyles,
  Group,
  Select,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconBolt,
  IconCategory,
  IconChevronDown,
  IconChristmasTree,
  IconCloud,
  IconHeartHandshake,
  IconHexagon,
  IconHexagon3d,
  IconHexagonPlus,
  IconList,
  IconPhotoAi,
} from '@tabler/icons-react';
import { useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import {
  DowngradeFeedbackModal,
  MembershipUpgradeModal,
} from '~/components/Stripe/MembershipChangePrevention';
import { appliesForFounderDiscount } from '~/components/Stripe/memberships.util';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import type { BenefitItem } from '~/components/Subscriptions/PlanBenefitList';
import { benefitIconSize, PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants, HOLIDAY_PROMO_VALUE } from '~/server/common/constants';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import type { SubscriptionPlan, UserSubscription } from '~/server/services/subscriptions.service';
import { isHolidaysTime } from '~/utils/date-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { formatKBytes, numberWithCommas } from '~/utils/number-helpers';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { getPlanDetails } from '~/components/Subscriptions/getPlanDetails';

type PlanCardProps = {
  product: SubscriptionPlan;
  subscription?: UserSubscription | null;
};

const subscribeBtnProps: Record<string, Partial<ButtonProps>> = {
  upgrade: {
    color: 'blue',
    variant: 'filled',
  },
  downgrade: {
    color: 'gray',
    variant: 'filled',
  },
  active: {
    color: 'gray',
    variant: 'outline',
  },
  subscribe: {
    color: 'blue',
    variant: 'filled',
  },
} as const;

export function PlanCard({ product, subscription }: PlanCardProps) {
  const features = useFeatureFlags();
  const hasActiveSubscription = subscription?.status === 'active';
  const _isActivePlan = hasActiveSubscription && subscription?.product?.id === product.id;
  const { classes } = useStyles();
  const meta = (product.metadata ?? {}) as SubscriptionProductMetadata;
  const subscriptionMeta = (subscription?.product.metadata ?? {}) as SubscriptionProductMetadata;
  const defaultPriceId = _isActivePlan
    ? subscription?.price.id ?? product.defaultPriceId
    : product.defaultPriceId;
  const [priceId, setPriceId] = useState<string | null>(
    product.prices.find((p) => p.id === defaultPriceId)?.id ??
      product.prices.find((p) => p.currency.toLowerCase() === 'usd')?.id ??
      product.prices[0].id
  );
  const price = product.prices.find((p) => p.id === priceId) ?? product.prices[0];
  const planDetails = getPlanDetails(product, features, price.interval === 'year') ?? {};
  const { benefits, image } = planDetails;
  const isSameInterval = _isActivePlan && subscription?.price.interval === price.interval;
  const isUpgrade =
    hasActiveSubscription &&
    (constants.memberships.tierOrder.indexOf(meta.tier) >
      constants.memberships.tierOrder.indexOf(subscriptionMeta.tier ?? '') ||
      (subscription?.price.interval === 'month' && price.interval === 'year'));
  const isDowngrade =
    hasActiveSubscription &&
    (constants.memberships.tierOrder.indexOf(meta.tier) <
      constants.memberships.tierOrder.indexOf(subscriptionMeta.tier ?? '') ||
      (subscription?.price.interval === 'year' && price.interval === 'month'));

  const isActivePlanDiffInterval = _isActivePlan && !isSameInterval;
  const isActivePlan = _isActivePlan && isSameInterval;

  const btnProps = isActivePlan
    ? subscribeBtnProps.active
    : isUpgrade
    ? subscribeBtnProps.upgrade
    : isDowngrade
    ? subscribeBtnProps.downgrade
    : subscribeBtnProps.subscribe;

  const disabledDueToProvider =
    !!subscription && subscription.product.provider !== product.provider;
  const disabledDueToYearlyPlan =
    !!subscription && subscription.price.interval === 'year' && price.interval === 'month';

  const ctaDisabled = disabledDueToProvider || disabledDueToYearlyPlan || features.disablePayments;

  const metadata = (subscription?.product?.metadata ?? {
    tier: 'free',
  }) as SubscriptionProductMetadata;
  const appliesForDiscount =
    !isActivePlan && appliesForFounderDiscount(metadata?.tier) && features.membershipsV2;

  return (
    <Card className={classes.card}>
      <Stack justify="space-between" style={{ height: '100%' }}>
        <Stack>
          <Stack spacing="md" mb="md">
            <Title className={classes.title} order={2} align="center" mb="sm">
              {product.name}
            </Title>
            {image && (
              <Center>
                <Box w={128} h={128}>
                  <EdgeMedia src={image} className={classes.image} />
                </Box>
              </Center>
            )}
            <Stack spacing={0} align="center">
              {appliesForDiscount ? (
                <Stack spacing={0} align="center">
                  <Text td="line-through" color="gray" component="span" align="center" lh={1}>
                    {getStripeCurrencyDisplay(price.unitAmount, price.currency)}
                  </Text>
                  <Group position="center" spacing={4} align="flex-end">
                    <Text className={classes.price} align="center" lh={1}>
                      {getStripeCurrencyDisplay(
                        price.unitAmount *
                          (constants.memberships.founderDiscount.discountPercent / 100),
                        price.currency
                      )}
                    </Text>
                    <Text align="center" color="dimmed">
                      / {shortenPlanInterval(price.interval)}
                    </Text>
                  </Group>
                </Stack>
              ) : (
                <Group position="center" spacing={4} align="flex-end">
                  <Text className={classes.price} align="center" lh={1}>
                    {getStripeCurrencyDisplay(price.unitAmount, price.currency)}
                  </Text>
                  <Text align="center" color="dimmed">
                    / {shortenPlanInterval(price.interval)}
                  </Text>
                </Group>
              )}
              <Select
                data={product.prices.map((p) => ({ label: p.currency, value: p.id }))}
                value={priceId}
                onChange={setPriceId}
                variant="unstyled"
                w={50}
                rightSection={<IconChevronDown size={14} />}
                rightSectionWidth={20}
                styles={(theme) => ({
                  root: {
                    marginTop: 2,
                    borderBottom: `2px solid ${theme.colors.blue[theme.fn.primaryShade()]}`,
                  },
                  input: {
                    textTransform: 'uppercase',
                    textAlign: 'left',
                    height: 20,
                    minHeight: 20,
                  },
                  item: {
                    textTransform: 'uppercase',
                    padding: '0 4px',
                    textAlign: 'center',
                  },
                  rightSection: {
                    marginRight: 0,
                  },
                })}
              />
            </Stack>

            {priceId && (
              <>
                {isActivePlan ? (
                  <Button radius="xl" {...btnProps} component={Link} href="/user/membership">
                    Manage your Membership
                  </Button>
                ) : isDowngrade ? (
                  <Button
                    radius="xl"
                    {...btnProps}
                    disabled={ctaDisabled}
                    onClick={() => {
                      dialogStore.trigger({
                        component: DowngradeFeedbackModal,
                        props: {
                          priceId,
                          upcomingVaultSizeKb: meta.vaultSizeKb,
                          fromTier: subscriptionMeta.tier,
                          toTier: meta.tier,
                        },
                      });
                    }}
                  >
                    Downgrade to {meta?.tier} {isActivePlanDiffInterval ? ' (Monthly)' : ''}
                  </Button>
                ) : isUpgrade ? (
                  <Button
                    radius="xl"
                    {...btnProps}
                    disabled={ctaDisabled}
                    onClick={() => {
                      dialogStore.trigger({
                        component: MembershipUpgradeModal,
                        props: {
                          priceId,
                          meta: planDetails,
                          price,
                        },
                      });
                    }}
                  >
                    Upgrade to {meta?.tier} {isActivePlanDiffInterval ? ' (Annual)' : ''}
                  </Button>
                ) : (
                  <SubscribeButton priceId={priceId} disabled={ctaDisabled}>
                    <Button radius="xl" {...btnProps}>
                      {isActivePlan ? `You are ${meta?.tier}` : `Subscribe to ${meta?.tier}`}
                    </Button>
                  </SubscribeButton>
                )}
              </>
            )}
          </Stack>
          {benefits && <PlanBenefitList benefits={benefits} tier={meta?.tier} />}
        </Stack>
      </Stack>
    </Card>
  );
}

const useStyles = createStyles((theme) => ({
  card: {
    height: '100%',
    background: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[0],
    borderRadius: theme.radius.md,
    padding: theme.spacing.lg,
  },
  image: {
    [containerQuery.smallerThan('sm')]: {
      width: 96,
      marginBottom: theme.spacing.xs,
    },
  },
  title: {
    [containerQuery.smallerThan('sm')]: {
      fontSize: 20,
    },
  },
  price: {
    fontSize: 48,
    fontWeight: 'bold',
  },
}));
