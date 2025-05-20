import {
  Button,
  ButtonProps,
  Card,
  Center,
  Group,
  Select,
  Stack,
  Text,
  ThemeIconVariant,
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
import {
  benefitIconSize,
  BenefitItem,
  PlanBenefitList,
} from '~/components/Subscriptions/PlanBenefitList';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants, HOLIDAY_PROMO_VALUE } from '~/server/common/constants';
import { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import { FeatureAccess } from '~/server/services/feature-flags.service';
import type { SubscriptionPlan, UserSubscription } from '~/server/services/subscriptions.service';
import { isHolidaysTime } from '~/utils/date-helpers';
import { formatKBytes, numberWithCommas } from '~/utils/number-helpers';
import { getStripeCurrencyDisplay } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

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

  const metadata = (subscription?.product?.metadata ?? {
    tier: 'free',
  }) as SubscriptionProductMetadata;
  const appliesForDiscount =
    !isActivePlan && appliesForFounderDiscount(metadata?.tier) && features.membershipsV2;

  return (
    <Card className="h-full rounded-md bg-gray-0 p-5 dark:bg-dark-8">
      <Stack justify="space-between" style={{ height: '100%' }}>
        <Stack>
          <Stack gap="md" mb="md">
            <Title className="text-center text-xl @sm:text-2xl" order={2} mb="sm">
              {product.name}
            </Title>
            {image && (
              <Center>
                <div className="mb-[10px] w-24 @sm:mb-0 @sm:w-32">
                  <EdgeMedia src={image} className="size-full object-cover" />
                </div>
              </Center>
            )}
            <Stack gap={0} align="center">
              {appliesForDiscount ? (
                <Stack gap={0} align="center">
                  <Text td="line-through" color="gray" component="span" align="center" lh={1}>
                    {getStripeCurrencyDisplay(price.unitAmount, price.currency)}
                  </Text>
                  <Group justify="center" gap={4} align="flex-end">
                    <Text className="text-5xl font-bold" align="center" lh={1}>
                      {getStripeCurrencyDisplay(
                        price.unitAmount *
                          (constants.memberships.founderDiscount.discountPercent / 100),
                        price.currency
                      )}
                    </Text>
                    <Text align="center" c="dimmed">
                      / {shortenPlanInterval(price.interval)}
                    </Text>
                  </Group>
                </Stack>
              ) : (
                <Group justify="center" gap={4} align="flex-end">
                  <Text className="text-5xl font-bold" align="center" lh={1}>
                    {getStripeCurrencyDisplay(price.unitAmount, price.currency)}
                  </Text>
                  <Text align="center" c="dimmed">
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
                classNames={{
                  root: 'mt-[2px] border-b-2 border-b-blue-9',
                  input: 'h-[20px] min-h-[20px] text-start uppercase',
                  option: 'px-[4px] text-center uppercase',
                  section: 'mr-0',
                }}
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
                    disabled={disabledDueToProvider || disabledDueToYearlyPlan}
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
                    disabled={disabledDueToProvider || disabledDueToYearlyPlan}
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
                  <SubscribeButton
                    priceId={priceId}
                    disabled={disabledDueToProvider || disabledDueToYearlyPlan}
                  >
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

export const getPlanDetails: (
  product: Pick<SubscriptionPlan, 'metadata' | 'name'>,
  features: FeatureAccess,
  isAnnual?: boolean
) => PlanMeta = (
  product: Pick<SubscriptionPlan, 'metadata' | 'name'>,
  features: FeatureAccess,
  isAnnual
) => {
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

      isHolidaysTime()
        ? {
            icon: <IconChristmasTree size={benefitIconSize} />,
            iconColor: (metadata?.monthlyBuzz ?? 0) === 0 ? 'gray' : 'green',
            iconVariant: 'light' as ThemeIconVariant,
            content: (
              <Text>
                <Text span color={(metadata?.monthlyBuzz ?? 0) === 0 ? undefined : 'green.7'}>
                  +
                  {numberWithCommas(Math.floor((metadata?.monthlyBuzz ?? 0) * HOLIDAY_PROMO_VALUE))}{' '}
                  Blue Buzz for December
                </Text>
              </Text>
            ),
          }
        : null,

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
      features.privateModels
        ? {
            icon: <IconCategory size={benefitIconSize} />,
            iconColor: 'blue',

            iconVariant: 'light' as ThemeIconVariant,
            content: (
              <Text>
                {numberWithCommas(
                  metadata?.maxPrivateModels ??
                    constants.memberships.membershipDetailsAddons[metadata.tier]
                      ?.maxPrivateModels ??
                    0
                )}{' '}
                Private Models
              </Text>
            ),
          }
        : null,
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
        icon: <IconHeartHandshake size={benefitIconSize} />,
        iconColor: !!metadata.tier && metadata.tier !== 'free' ? 'blue' : 'gray',

        iconVariant: 'light' as ThemeIconVariant,
        content: (
          <Text>
            {metadata?.supportLevel ??
              constants.memberships.membershipDetailsAddons[metadata.tier]?.supportLevel ??
              'Basic'}{' '}
            Support
          </Text>
        ),
      },
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
      {
        content:
          !!metadata.badgeType && !!isAnnual ? (
            <Text lh={1}>
              <Text
                variant="link"
                td="underline"
                component="a"
                href="/articles/14950"
                target="_blank"
              >
                Exclusive cosmetics
              </Text>
            </Text>
          ) : (
            <Text lh={1}>
              No{' '}
              <Text
                variant="link"
                td="underline"
                component="a"
                href="/articles/14950"
                target="_blank"
              >
                exclusive cosmetics
              </Text>
            </Text>
          ),
        icon: <IconHexagon3d size={benefitIconSize} />,
        iconColor:
          !metadata.badgeType || metadata.badgeType === 'none' || !isAnnual ? 'gray' : 'blue',
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
