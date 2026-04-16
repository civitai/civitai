import {
  Alert,
  Anchor,
  Badge,
  Button,
  Center,
  Container,
  Grid,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconArrowRight, IconSparkles } from '@tabler/icons-react';
import { NextLink } from '~/components/NextLink/NextLink';
import { usePaymentProvider } from '~/components/Payments/usePaymentProvider';
import { useRouter } from 'next/router';
import React from 'react';
import classes from '~/components/Buzz/buzz.module.scss';
import { CreatorProgramV2 } from '~/components/Buzz/CreatorProgramV2/CreatorProgramV2';
import { BuzzDashboardOverview } from '~/components/Buzz/Dashboard/BuzzDashboardOverview';
import { EarningBuzz, RewardsList } from '~/components/Buzz/FeatureCards/FeatureCards';
import { GetPaid } from '~/components/Buzz/GetPaid/GetPaid';
import { DailyCreatorCompReward } from '~/components/Buzz/Rewards/DailyCreatorCompReward';
import { GeneratedImagesReward } from '~/components/Buzz/Rewards/GeneratedImagesRewards';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { Meta } from '~/components/Meta/Meta';
import { RedeemCodeCard } from '~/components/RedeemCode/RedeemCodeCard';
import { RefreshSessionButton } from '~/components/RefreshSessionButton/RefreshSessionButton';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { PrepaidTokenOverview } from '~/components/Subscriptions/PrepaidTokenOverview';
import type {
  SubscriptionMetadata,
  SubscriptionProductMetadata,
} from '~/server/schema/subscriptions.schema';
import { getPrepaidTokens, getNextTokenUnlockDate } from '~/shared/utils/subscription-tokens';
import { PaymentProvider } from '~/shared/utils/prisma/enums';
import { PurchasedCodesCard } from '~/components/Account/PurchasedCodesCard';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { formatMultiplier, formatRewardsBoost, getAccountTypeLabel } from '~/utils/buzz';
import { trpc } from '~/utils/trpc';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.buzz) {
      return { notFound: true };
    }

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
  },
});

export default function UserBuzzDashboard() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const isMember = currentUser?.isMember;
  const features = useFeatureFlags();
  const [mainBuzztype] = useAvailableBuzz();

  // Account type selection state
  const buzzTypeFromQuery = router.query.buzzType as BuzzSpendType | undefined;
  const initialBuzzType =
    buzzTypeFromQuery && buzzSpendTypes.includes(buzzTypeFromQuery)
      ? buzzTypeFromQuery
      : mainBuzztype;
  const [selectedAccountType, setSelectedAccountType] =
    React.useState<BuzzSpendType>(initialBuzzType);

  const selectedBuzzConfig = useBuzzCurrencyConfig(selectedAccountType);

  // Account type options for SegmentedControl
  const accountTypeOptions = React.useMemo(
    () =>
      buzzSpendTypes.map((type) => ({
        label: getAccountTypeLabel(type),
        value: type,
      })),
    []
  );

  const { data: rewards = [], isLoading: loadingRewards } = trpc.user.userRewardDetails.useQuery(
    undefined,
    { enabled: !!currentUser }
  );

  const paymentProvider = usePaymentProvider();
  const showBlueBuzzUpsell =
    !isMember && features.membershipsV2 && selectedAccountType === 'blue';
  const { data: plans = [] } = trpc.subscriptions.getPlans.useQuery(
    { paymentProvider },
    { enabled: showBlueBuzzUpsell }
  );
  const maxRewardsMultiplier = Math.max(
    1,
    ...plans.map((p) => (p.metadata as SubscriptionProductMetadata)?.rewardsMultiplier ?? 1)
  );

  const { multipliers, multipliersLoading } = useUserMultipliers();
  const rewardsMultiplier = multipliers.rewardsMultiplier;
  const globalRewardsBonus = multipliers.globalRewardsBonus;
  const baseRewardsMultiplier = multipliers.baseRewardsMultiplier;
  const { subscription, subscriptionPaymentProvider } = useActiveSubscription({
    buzzType: selectedAccountType,
  });
  const isCivitaiPrepaid = subscriptionPaymentProvider === PaymentProvider.Civitai;

  const filteredRewards = rewards.filter((reward) => reward.accountType === selectedAccountType);
  const hasRewards = filteredRewards.length > 0;

  return (
    <>
      <Meta title="Civitai | My Buzz Dashboard" deIndex />
      <Container size="lg">
        <Stack gap="md">
          <Stack gap="md">
            <Group justify="space-between" align="center">
              <Title order={1}>My Buzz Dashboard</Title>

              {/* Account Type Selector */}
              <SegmentedControl
                size="sm"
                value={selectedAccountType}
                onChange={(value) => setSelectedAccountType(value as BuzzSpendType)}
                data={accountTypeOptions}
              />
            </Group>
          </Stack>

          <BuzzDashboardOverview
            accountId={currentUser?.id as number}
            selectedAccountType={selectedAccountType}
          />

          {/* Get Buzz section */}
          {selectedAccountType !== 'blue' && (
            <Stack gap={2} mt="xl">
              <Title order={2} style={{ color: selectedBuzzConfig.color }}>
                Get {getAccountTypeLabel(selectedAccountType)} Buzz
              </Title>
              <Text c="dimmed" size="sm">
                Multiple ways to get {getAccountTypeLabel(selectedAccountType)} Buzz and power your
                creativity
              </Text>
            </Stack>
          )}

          {/* Feature cards (2x2) + Redeem/Purchased codes sidebar */}
          {selectedAccountType === 'yellow' ? (
            <Grid align="stretch">
              <Grid.Col span={{ base: 12, md: 7 }}>
                <EarningBuzz withCTA accountType={selectedAccountType} hideHeader columns={2} />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 5 }}>
                <Stack gap="md" h="100%">
                  <RedeemCodeCard size="md" />
                  <PurchasedCodesCard compact />
                </Stack>
              </Grid.Col>
            </Grid>
          ) : selectedAccountType !== 'blue' ? (
            <EarningBuzz withCTA accountType={selectedAccountType} hideHeader />
          ) : null}

          {/* Prepaid Token Claim Section (yellow buzz only, Civitai prepaid members) */}
          {selectedAccountType === 'yellow' &&
            isCivitaiPrepaid &&
            subscription &&
            (() => {
              const prepaidTokens = getPrepaidTokens({
                metadata: subscription.metadata as SubscriptionMetadata,
              });
              const nextUnlockDate = getNextTokenUnlockDate(subscription.currentPeriodStart);
              return (
                <PrepaidTokenOverview
                  tokens={prepaidTokens}
                  nextUnlockDate={nextUnlockDate}
                  subscription={subscription}
                />
              );
            })()}

          {/* Ways to Earn Rewards (hidden when empty) */}
          {(loadingRewards || multipliersLoading || hasRewards) && (
            <Paper className={classes.tileCard} p="lg" radius="md">
              <Stack>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xl font-bold" id="rewards">
                    Ways to earn {getAccountTypeLabel(selectedAccountType)} Buzz
                  </h3>
                  {globalRewardsBonus > 1 ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {baseRewardsMultiplier > 1 && (
                        <>
                          <Badge size="lg" radius="xl" variant="light" color="gray">
                            Membership {formatMultiplier(baseRewardsMultiplier)}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            ×
                          </Text>
                        </>
                      )}
                      <Badge
                        size="lg"
                        radius="xl"
                        variant="light"
                        color="yellow"
                        leftSection={<IconSparkles size={14} />}
                      >
                        Event {formatMultiplier(globalRewardsBonus)}
                      </Badge>
                      <Text size="xs" c="dimmed">
                        =
                      </Text>
                      <Badge size="lg" radius="xl" variant="light" color="blue" fw={700}>
                        Total {formatMultiplier(rewardsMultiplier)}
                      </Badge>
                    </div>
                  ) : isMember && rewardsMultiplier > 1 && features.membershipsV2 ? (
                    <Badge size="lg" radius="xl" variant="light" color="blue" fw={700}>
                      Membership {formatMultiplier(rewardsMultiplier)}
                    </Badge>
                  ) : showBlueBuzzUpsell && maxRewardsMultiplier > 1 ? (
                    <Button
                      component={NextLink}
                      href="/pricing"
                      size="sm"
                      radius="xl"
                      className={classes.upsellCta}
                      leftSection={
                        <IconSparkles size={16} className={classes.upsellCtaIcon} />
                      }
                      rightSection={<IconArrowRight size={16} />}
                    >
                      Earn {formatRewardsBoost(maxRewardsMultiplier)} Blue Buzz with a membership
                    </Button>
                  ) : (
                    isMember &&
                    features.membershipsV2 && (
                      <Text size="sm" c="dimmed">
                        Check out the{' '}
                        <Anchor
                          component="button"
                          onClick={() => setSelectedAccountType('blue')}
                          c="blue.4"
                        >
                          Blue Buzz rewards
                        </Anchor>{' '}
                        available.
                      </Text>
                    )
                  )}
                </div>
                {loadingRewards || multipliersLoading ? (
                  <Center py="xl">
                    <Loader />
                  </Center>
                ) : (
                  <RewardsList
                    rewards={filteredRewards}
                    accountType={selectedAccountType}
                    onAccountTypeChange={setSelectedAccountType}
                  />
                )}
              </Stack>
            </Paper>
          )}
          <GeneratedImagesReward />
          {features.creatorComp && <DailyCreatorCompReward buzzAccountType={selectedAccountType} />}
          {(selectedAccountType === 'yellow' || selectedAccountType === 'green') && (
            <CreatorProgramV2 />
          )}
          {selectedAccountType === 'red' && <GetPaid />}
        </Stack>
      </Container>
    </>
  );
}
