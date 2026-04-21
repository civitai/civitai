import type { ButtonProps } from '@mantine/core';
import { Button, Card, Center, Divider, Group, Select, Stack, Text, Title } from '@mantine/core';
import { IconChevronDown } from '@tabler/icons-react';
import { useCallback, useRef, useState } from 'react';
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
import { PaymentProvider } from '~/shared/utils/prisma/enums';

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
  const ctaDisabled =
    disabledDueToProvider ||
    disabledDueToYearlyPlan ||
    (features.disablePayments && !redirectToPrepaidPage);

  const metadata = (subscription?.product?.metadata ?? {
    tier: 'free',
  }) as SubscriptionProductMetadata;

  // Spotlight + border glow tracking
  const cardRef = useRef<HTMLDivElement>(null);
  const spotlightRef = useRef<HTMLDivElement>(null);
  const borderGlowRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Inner spotlight on top section
    const el = spotlightRef.current;
    if (el) {
      el.style.background = `radial-gradient(250px circle at ${x}px ${y}px, rgba(190,75,219,0.12), transparent 70%)`;
      el.style.opacity = '1';
    }

    // Border glow
    const border = borderGlowRef.current;
    if (border) {
      border.style.background = `radial-gradient(400px circle at ${x}px ${y}px, rgba(190,75,219,0.15), transparent 70%)`;
      border.style.opacity = '1';
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    const el = spotlightRef.current;
    if (el) el.style.opacity = '0';
    const border = borderGlowRef.current;
    if (border) border.style.opacity = '0';
  }, []);

  return (
    <div
      ref={cardRef}
      className="relative h-full"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      {/* Border glow overlay */}
      <div
        ref={borderGlowRef}
        className="pointer-events-none absolute -inset-px rounded-xl transition-opacity duration-500"
        style={{ opacity: 0 }}
      />

      <Card className="relative z-[1] h-full overflow-hidden rounded-xl border border-dark-4 p-0 dark:bg-dark-7">
        <Stack justify="space-between" className="h-full">
          <Stack gap={0}>
            {/* Top section — darker with gradient + spotlight */}
            <div className="relative overflow-hidden bg-dark-8 p-5 pb-4">
              {/* Subtle gradient tint */}
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    'linear-gradient(135deg, rgba(190,75,219,0.1) 0%, rgba(190,75,219,0.02) 100%)',
                }}
              />
              {/* Spotlight glow */}
              <div
                ref={spotlightRef}
                className="pointer-events-none absolute inset-0 transition-opacity duration-500"
                style={{ opacity: 0 }}
              />

              <Stack gap="md" className="relative">
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
                    onChange={(val) => val && setPriceId(val)}
                    allowDeselect={false}
                    variant="unstyled"
                    w={50}
                    withCheckIcon={false}
                    rightSection={<IconChevronDown size={14} />}
                    rightSectionWidth={20}
                    comboboxProps={{ width: 80, position: 'bottom' }}
                    classNames={{
                      root: 'mt-[2px] border-b-2 border-b-current',
                      input: 'h-[20px] min-h-[20px] text-start uppercase',
                      option: 'px-[4px] text-center uppercase data-[checked]:bg-dark-5 data-[checked]:font-bold',
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
                        component={Link}
                        href="/purchase/buzz"
                        radius="xl"
                        {...btnProps}
                      >
                        Purchase Buzz
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
                        Downgrade to {capitalize(meta?.tier)} {isActivePlanDiffInterval ? ' (Monthly)' : ''}
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
                        Upgrade to {capitalize(meta?.tier)} {isActivePlanDiffInterval ? ' (Annual)' : ''}
                      </Button>
                    ) : (
                      <SubscribeButton
                        priceId={priceId}
                        disabled={ctaDisabled}
                        forceProvider={meta.buzzType === 'green' ? PaymentProvider.Stripe : undefined}
                      >
                        <Button radius="xl" {...btnProps}>
                          {isActivePlan ? `You are ${capitalize(meta?.tier)}` : `Subscribe to ${capitalize(meta?.tier)}`}
                        </Button>
                      </SubscribeButton>
                    )}
                  </>
                )}
              </Stack>
            </div>

            {/* Divider above features */}
            <Divider className="border-dark-5" />

            {/* Benefits section — slightly darker than default */}
            {benefits && (
              <div className="bg-dark-8/50 p-5 pt-4">
                <PlanBenefitList benefits={benefits} tier={meta?.tier} buzzType={meta.buzzType} />
              </div>
            )}
          </Stack>
        </Stack>
      </Card>
    </div>
  );
}
