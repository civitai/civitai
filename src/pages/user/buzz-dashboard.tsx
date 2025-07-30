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
import React from 'react';
import classes from '~/components/Buzz/buzz.module.scss';
import { CreatorProgramV2 } from '~/components/Buzz/CreatorProgramV2/CreatorProgramV2';
import { BuzzDashboardOverview } from '~/components/Buzz/Dashboard/BuzzDashboardOverview';
import { EarningBuzz } from '~/components/Buzz/FeatureCards/FeatureCards';
import { DailyCreatorCompReward } from '~/components/Buzz/Rewards/DailyCreatorCompReward';
import { GeneratedImagesReward } from '~/components/Buzz/Rewards/GeneratedImagesRewards';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { RedeemCodeCard } from '~/components/RedeemCode/RedeemCodeCard';
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
  const isMember = currentUser?.isMember;
  const { isFreeTier, meta } = useActiveSubscription();
  const features = useFeatureFlags();
  const blueBuzzConfig = useBuzzCurrencyConfig('blue');

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
        links={
          env.NEXT_PUBLIC_BASE_URL
            ? [{ href: `${env.NEXT_PUBLIC_BASE_URL}/user/buzz-dashboard`, rel: 'canonical' }]
            : undefined
        }
        deIndex
      />
      <Container size="lg">
        <Stack gap="xl">
          <Title order={1}>My Buzz Dashboard</Title>

          <BuzzDashboardOverview accountId={currentUser?.id as number} />

          {/* Redeem Buzz Code Section */}
          <RedeemCodeCard />

          <EarningBuzz withCTA />

          <Paper className={classes.tileCard} h="100%">
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
              <Group justify="space-between">
                <Title order={3} id="rewards">
                  Other ways you can earn Buzz
                </Title>
                {isMember && rewardsMultiplier > 1 && features.membershipsV2 && (
                  <Tooltip multiline label="Your membership makes rewards worth more!">
                    <Stack gap={0}>
                      <Text
                        size="md"
                        style={{ fontSize: 20 }}
                        fw={700}
                        className={blueBuzzConfig.classNames?.gradientText}
                      >
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
                    <Stack key={reward.type} gap={4}>
                      <Group justify="space-between" mih={30}>
                        <Group wrap="nowrap" gap="xs">
                          <Stack gap={4} align="center">
                            <CurrencyBadge
                              w={100}
                              currency={Currency.BUZZ}
                              unitAmount={reward.awardAmount}
                              type={reward.accountType}
                            />
                            {rewardsMultiplier > 1 && (
                              <Text
                                size="xs"
                                style={{ fontSize: 10 }}
                                color={reward.accountType === 'blue' ? 'blue.4' : 'yellow.7'}
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
                            <WatchAdButton size="compact-xs" disabled={awardedAmountPercent >= 1} />
                          )}
                        </Group>
                        {reward.cap && (
                          <Group gap={4}>
                            <CurrencyIcon
                              size={14}
                              currency={Currency.BUZZ}
                              type={reward.accountType}
                            />
                            <Text c="dimmed" size="xs">
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
                                        : reward.accountType === 'blue'
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
            <Text c="blue.4" td="underline" component={Link} href="/collections/3870938">
              Buzz Beggars Board
            </Text>
            .
          </Text>
          <GeneratedImagesReward />
          {features.creatorComp && <DailyCreatorCompReward />}
          <CreatorProgramV2 />
        </Stack>
      </Container>
    </>
  );
}
