import type { ButtonProps } from '@mantine/core';
import { Button, Card, Center, Group, Select, Stack, Text, Title } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import {
  DowngradeFeedbackModal,
  MembershipUpgradeModal,
} from '~/components/Stripe/MembershipChangePrevention';
import { shortenPlanInterval } from '~/components/Stripe/stripe.utils';
import { SubscribeButton } from '~/components/Stripe/SubscribeButton';
import { PlanBenefitList } from '~/components/Subscriptions/PlanBenefitList';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';
import type { SubscriptionPlan, UserSubscription } from '~/server/services/subscriptions.service';
import { capitalize, getStripeCurrencyDisplay } from '~/utils/string-helpers';
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
  const _isActivePlan =
    hasActiveSubscription &&
    (subscription?.product?.id === product.id ||
      // @ts-ignore product metadata will always have tier
      subscription?.product?.metadata?.tier === product.metadata?.tier);
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

  const redirectToPrepaidPage = features.disablePayments && features.prepaidMemberships;
  const ctaDisabled = disabledDueToProvider || disabledDueToYearlyPlan || !redirectToPrepaidPage;

  const metadata = (subscription?.product?.metadata ?? {
    tier: 'free',
  }) as SubscriptionProductMetadata;

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
              <Group justify="center" gap={4} align="flex-end">
                <Text className="text-5xl font-bold" align="center" lh={1}>
                  {getStripeCurrencyDisplay(price.unitAmount, price.currency)}
                </Text>
                <Text align="center" c="dimmed">
                  / {shortenPlanInterval(price.interval)}
                </Text>
              </Group>
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
                ) : redirectToPrepaidPage ? (
                  <Button
                    component="a"
                    target="_blank"
                    href="https://buybuzz.io/collections/memberships"
                    rel="noopener noreferrer"
                    radius="xl"
                    {...btnProps}
                  >
                    Get Prepaid {capitalize(meta?.tier)}
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
