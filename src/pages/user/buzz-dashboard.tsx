import {
  Alert,
  Anchor,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  Paper,
  RingProgress,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import React, { useEffect } from 'react';
import { UserPaymentConfigurationCard } from '~/components/Account/UserPaymentConfigurationCard';
import { useBuzzDashboardStyles } from '~/components/Buzz/buzz.styles';
import { BuzzDashboardOverview } from '~/components/Buzz/Dashboard/BuzzDashboardOverview';
import { EarningBuzz, SpendingBuzz } from '~/components/Buzz/FeatureCards/FeatureCards';
import { DailyCreatorCompReward } from '~/components/Buzz/Rewards/DailyCreatorCompReward';
import { EarlyAccessRewards } from '~/components/Buzz/Rewards/EarlyAccessRewards';
import { GeneratedImagesReward } from '~/components/Buzz/Rewards/GeneratedImagesRewards';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { OwnedBuzzWithdrawalRequestsPaged } from '~/components/Buzz/WithdrawalRequest/OwnedBuzzWithdrawalRequestsPaged';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PurchasableRewards } from '~/components/PurchasableRewards/PurchasableRewards';
import { RefreshSessionButton } from '~/components/RefreshSessionButton/RefreshSessionButton';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { WatchAdButton } from '~/components/WatchAdButton/WatchAdButton';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Currency } from '~/shared/utils/prisma/enums';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

const RedeemCodeModal = dynamic(() =>
  import('~/components/RedeemableCode/RedeemCodeModal').then((x) => x.RedeemCodeModal)
);

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
  const currentUser = useCurrentUser();
  const { classes } = useBuzzDashboardStyles();
  const isMember = currentUser?.isMember;
  const { isFreeTier, meta } = useActiveSubscription();
  const { query } = useRouter();
  const features = useFeatureFlags();

  // Handle direct redemption
  useEffect(() => {
    if (!query?.redeem || typeof window === 'undefined') return;
    dialogStore.trigger({
      id: 'redeem-code',
      component: RedeemCodeModal,
      props: { code: query.redeem as string },
    });
  }, [query.redeem]);

  const { data: rewards = [], isLoading: loadingRewards } = trpc.user.userRewardDetails.useQuery(
    undefined,
    { enabled: !!currentUser }
  );

  const { multipliers, multipliersLoading } = useUserMultipliers();
  const rewardsMultiplier = multipliers.rewardsMultiplier ?? 1;
  const showMismatchAlert =
    isMember &&
    !multipliersLoading &&
    rewardsMultiplier !== Number(meta?.rewardsMultiplier ?? 1) &&
    features.membershipsV2 &&
    !isFreeTier;

  return (
    <>
      <Meta
        title="Civitai | My Buzz Dashboard"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/user/buzz-dashboard`, rel: 'canonical' }]}
        deIndex
      />
      <Container size="lg">
        <Stack spacing="xl">
          <Title order={1}>My Buzz Dashboard</Title>

          <BuzzDashboardOverview accountId={currentUser?.id as number} />

          <UserPaymentConfigurationCard />
          <OwnedBuzzWithdrawalRequestsPaged />

          <EarningBuzz withCTA />

          <Paper withBorder className={classes.tileCard} h="100%">
            <Stack p="md">
              {showMismatchAlert && (
                <Alert color="red" title="Looks like we have an issue!">
                  <Text>
                    Looks like your subscription isn&rsquo;t correctly applying benefits or Buzz.
                    Try to <RefreshSessionButton />, if that doesn&rsquo;t work please contact
                    support <Anchor href="https://civitai.com/support">here</Anchor>
                  </Text>
                </Alert>
              )}
              <Group position="apart">
                <Title order={3} id="rewards">
                  Other ways you can earn Buzz
                </Title>
                {isMember && rewardsMultiplier > 1 && features.membershipsV2 && (
                  <Tooltip multiline label="Your membership makes rewards worth more!">
                    <Stack spacing={0}>
                      <Text size={20} className={classes.goldText}>
                        Rewards Multiplier: {rewardsMultiplier}x
                      </Text>
                    </Stack>
                  </Tooltip>
                )}
              </Group>
              {loadingRewards || multipliersLoading ? (
                <Center py="xl">
                  <Loader />
                </Center>
              ) : (
                rewards.map((reward, i) => {
                  const hasAwarded = reward.awarded !== -1;
                  const last = i === rewards.length - 1;
                  const awardedAmountPercent =
                    reward.cap && hasAwarded ? reward.awarded / reward.cap : 0;

                  return (
                    <Stack key={reward.type} spacing={4}>
                      <Group position="apart" mih={30}>
                        <Group noWrap spacing="xs">
                          <Stack spacing={4} align="center">
                            <CurrencyBadge
                              w={100}
                              currency={Currency.BUZZ}
                              unitAmount={reward.awardAmount}
                              type={reward.accountType}
                            />
                            {rewardsMultiplier > 1 && (
                              <Text
                                size={10}
                                color={reward.accountType === 'generation' ? 'blue.4' : 'yellow.7'}
                              >
                                Originally {Math.floor(reward.awardAmount / rewardsMultiplier)} Buzz
                              </Text>
                            )}
                          </Stack>
                          <Text>{reward.triggerDescription ?? reward.description}</Text>
                          {reward.tooltip && (
                            <Tooltip label={reward.tooltip} maw={250} multiline withArrow>
                              <IconInfoCircle size={20} style={{ flexShrink: 0 }} />
                            </Tooltip>
                          )}
                          {reward.type === 'adWatched' && (
                            <WatchAdButton size="xs" disabled={awardedAmountPercent >= 1} compact />
                          )}
                        </Group>
                        {reward.cap && (
                          <Group spacing={4}>
                            <CurrencyIcon size={14} type={reward.accountType} />
                            <Text color="dimmed" size="xs">
                              {hasAwarded
                                ? `${reward.awarded} / ${reward.cap.toLocaleString()} `
                                : `${reward.cap.toLocaleString()} `}
                              {' ('}
                              {reward.interval ?? 'day'}
                              {')'}
                            </Text>
                            {hasAwarded && (
                              <RingProgress
                                size={30}
                                thickness={9}
                                sections={[
                                  {
                                    value: awardedAmountPercent * 100,
                                    color:
                                      awardedAmountPercent === 1
                                        ? 'green'
                                        : reward.accountType === 'generation'
                                        ? 'blue.4'
                                        : 'yellow.7',
                                  },
                                ]}
                              />
                            )}
                          </Group>
                        )}
                      </Group>
                      {!last && <Divider mt="xs" />}
                    </Stack>
                  );
                })
              )}
            </Stack>
          </Paper>
          <Text mt={-16} size="sm" mb="xs" align="right">
            Still looking for ways to get more Buzz? Consider posting to the{' '}
            <Text variant="link" td="underline" component={Link} href="/collections/3870938">
              Buzz Beggars Board
            </Text>
            .
          </Text>
          <EarlyAccessRewards />
          <GeneratedImagesReward />
          {features.creatorComp && <DailyCreatorCompReward />}
          <SpendingBuzz withCTA />
          <PurchasableRewards />
        </Stack>
      </Container>
    </>
  );
}
