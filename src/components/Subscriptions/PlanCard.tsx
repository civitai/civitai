import {
  Stack,
  Card,
  Title,
  Text,
  Center,
  createStyles,
  Group,
  Select,
  Button,
  ButtonProps,
  ThemeIconVariant,
  Box,
} from '@mantine/core';
import {
  IconBolt,
  IconChevronDown,
  IconCloud,
  IconHexagon,
  IconHexagonPlus,
  IconList,
  IconPhotoAi,
} from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  benefitIconSize,
  BenefitItem,
  PlanBenefitList,
} from '~/components/Subscriptions/PlanBenefitList';
import { containerQuery } from '~/utils/mantine-css-helpers';
import type { SubscriptionPlan, UserSubscription } from '~/server/services/subscriptions.service';
import { useState } from 'react';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { formatKBytes, numberWithCommas } from '~/utils/number-helpers';
import { constants } from '~/server/common/constants';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { FeatureAccess } from '~/server/services/feature-flags.service';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import {
  DowngradeFeedbackModal,
  MembershipUpgradeModal,
} from '~/components/Stripe/MembershipChangePrevention';
import { appliesForFounderDiscount } from '~/components/Stripe/memberships.util';
import { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { NextLink as Link } from '~/components/NextLink/NextLink';

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
  const isActivePlan = hasActiveSubscription && subscription?.product?.id === product.id;
  const { classes } = useStyles();
  const meta = (product.metadata ?? {}) as SubscriptionProductMetadata;
  const subscriptionMeta = (subscription?.product.metadata ?? {}) as SubscriptionProductMetadata;
  const isUpgrade =
    hasActiveSubscription &&
    constants.memberships.tierOrder.indexOf(meta.tier) >
      constants.memberships.tierOrder.indexOf(subscriptionMeta.tier ?? '');
  const isDowngrade =
    hasActiveSubscription &&
    constants.memberships.tierOrder.indexOf(meta.tier) <
      constants.memberships.tierOrder.indexOf(subscriptionMeta.tier ?? '');
  const planDetails = getPlanDetails(product, features) ?? {};
  const { benefits, image } = planDetails;
  const defaultPriceId = isActivePlan
    ? subscription?.price.id ?? product.defaultPriceId
    : product.defaultPriceId;
  const [priceId, setPriceId] = useState<string | null>(defaultPriceId);
  const price = product.prices.find((p) => p.id === priceId) ?? product.prices[0];
  const btnProps = isActivePlan
    ? subscribeBtnProps.active
    : isUpgrade
    ? subscribeBtnProps.upgrade
    : isDowngrade
    ? subscribeBtnProps.downgrade
    : subscribeBtnProps.subscribe;

  const disabledDueToProvider =
    !!subscription && subscription.product.provider !== product.provider;

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
                <Box w={128}>
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
                    disabled={disabledDueToProvider}
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
                    Downgrade to {meta?.tier}
                  </Button>
                ) : isUpgrade ? (
                  <Button
                    radius="xl"
                    {...btnProps}
                    disabled={disabledDueToProvider}
                    onClick={() => {
                      dialogStore.trigger({
                        component: MembershipUpgradeModal,
                        props: {
                          priceId,
                          meta: planDetails,
                        },
                      });
                    }}
                  >
                    Upgrade to {meta?.tier}
                  </Button>
                ) : (
                  <SubscribeButton priceId={priceId} disabled={disabledDueToProvider}>
                    <Button radius="xl" {...btnProps}>
                      {isActivePlan ? `You are ${meta?.tier}` : `Subscribe to ${meta?.tier}`}
                    </Button>
                  </SubscribeButton>
                )}
              </>
            )}
          </Stack>
          {benefits && <PlanBenefitList benefits={benefits} />}
        </Stack>
      </Stack>
    </Card>
  );
}

export const getPlanDetails: (
  product: Pick<SubscriptionPlan, 'metadata' | 'name'>,
  features: FeatureAccess
) => PlanMeta = (product: Pick<SubscriptionPlan, 'metadata' | 'name'>, features: FeatureAccess) => {
  const metadata = (product.metadata ?? {}) as SubscriptionProductMetadata;
  const planMeta = {
    name: product?.name ?? 'Supporter Tier',
    image:
      metadata?.badge ?? constants.memberships.badges[metadata.tier] ?? constants.supporterBadge,
    benefits: [
      {
        icon: <IconBolt size={benefitIconSize} />,
        iconColor: (metadata?.monthlyBuzz ?? 0) === 0 ? 'gray' : 'yellow',
        iconVariant: 'light' as ThemeIconVariant,
        content: (
          <Text>
            <Text span color={(metadata?.monthlyBuzz ?? 0) === 0 ? undefined : 'yellow.7'}>
              {numberWithCommas(metadata?.monthlyBuzz ?? 0)} Buzz per month
            </Text>
          </Text>
        ),
      },
      features.membershipsV2
        ? {
            icon: <IconBolt size={benefitIconSize} />,
            iconColor: (metadata?.purchasesMultiplier ?? 1) === 1 ? 'gray' : 'yellow',
            iconVariant: 'light' as ThemeIconVariant,
            content:
              (metadata?.purchasesMultiplier ?? 1) === 1 ? (
                <Text>
                  <Text span>No bonus Buzz on purchases</Text>
                </Text>
              ) : (
                <Text>
                  <Text span color="yellow.7">
                    {(((metadata?.purchasesMultiplier ?? 1) - 1) * 100).toFixed(0)}% Bonus Buzz on
                    purchases
                  </Text>
                </Text>
              ),
          }
        : undefined,
      features.membershipsV2
        ? {
            icon: <IconBolt size={benefitIconSize} />,
            iconColor: (metadata?.rewardsMultiplier ?? 1) === 1 ? 'gray' : 'yellow',
            iconVariant: 'light' as ThemeIconVariant,
            content:
              (metadata?.rewardsMultiplier ?? 1) === 1 ? (
                <Text>
                  <Text span>No extra Buzz on rewards</Text>
                </Text>
              ) : (
                <Text>
                  <Text span color="yellow.7">
                    Rewards give {(((metadata?.rewardsMultiplier ?? 1) - 1) * 100).toFixed(0)}% more
                    Buzz!
                  </Text>
                </Text>
              ),
          }
        : undefined,
      {
        icon: <IconPhotoAi size={benefitIconSize} />,
        iconColor: 'blue',
        iconVariant: 'light' as ThemeIconVariant,
        content: <Text>{metadata.quantityLimit ?? 4} Images per job</Text>,
      },
      {
        icon: <IconList size={benefitIconSize} />,
        iconColor: 'blue',
        iconVariant: 'light' as ThemeIconVariant,
        content: <Text>{metadata.queueLimit ?? 4} Queued jobs</Text>,
      },
      features.vault
        ? {
            content: (
              <Text>
                {(metadata.vaultSizeKb ?? 0) === 0
                  ? 'No '
                  : formatKBytes(metadata.vaultSizeKb ?? 0)}{' '}
                <Text
                  variant="link"
                  td="underline"
                  component="a"
                  href="/product/vault"
                  target="_blank"
                >
                  Civitai Vault storage
                </Text>
              </Text>
            ),
            icon: <IconCloud size={benefitIconSize} />,
            iconColor: metadata.vaultSizeKb ? 'blue' : 'gray',
            iconVariant: 'light' as ThemeIconVariant,
          }
        : undefined,
      {
        content:
          metadata.badgeType === 'animated' ? (
            <Text lh={1}>
              Unique{' '}
              <Text lh={1} weight={700} component="span">
                Animated
              </Text>{' '}
              Supporter Badge each month
            </Text>
          ) : metadata.badgeType === 'static' ? (
            <Text lh={1}>Unique Supporter Badge each month</Text>
          ) : (
            <Text lh={1}>No Unique Supporter Badge each month</Text>
          ),
        icon:
          metadata.badgeType === 'animated' ? (
            <IconHexagonPlus size={benefitIconSize} />
          ) : (
            <IconHexagon size={benefitIconSize} />
          ),
        iconColor: !metadata.badgeType || metadata.badgeType === 'none' ? 'gray' : 'blue',
        iconVariant: 'light' as ThemeIconVariant,
      },
    ].filter(isDefined),
  };

  return planMeta;
};

export type PlanMeta = {
  name: string;
  image: string;
  benefits: BenefitItem[];
};

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
