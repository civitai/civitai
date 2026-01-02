import {
  Alert,
  Anchor,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
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
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { RedeemCodeCard } from '~/components/RedeemCode/RedeemCodeCard';
import { RefreshSessionButton } from '~/components/RefreshSessionButton/RefreshSessionButton';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { getAccountTypeLabel } from '~/utils/buzz';
import { trpc } from '~/utils/trpc';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';

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
  const { isFreeTier, meta } = useActiveSubscription();
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

  const { multipliers, multipliersLoading } = useUserMultipliers();
  const rewardsMultiplier = multipliers.rewardsMultiplier ?? 1;

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

          {/* Redeem Buzz Code Section */}
          {selectedAccountType === 'yellow' && <RedeemCodeCard />}

          {selectedAccountType !== 'blue' && (
            <EarningBuzz withCTA accountType={selectedAccountType} />
          )}

          <Paper className={classes.tileCard} h="100%">
            <Stack p="md">
              <Group justify="space-between">
                <Title order={3} id="rewards">
                  Ways to earn {getAccountTypeLabel(selectedAccountType)} Buzz
                </Title>
                {isMember && rewardsMultiplier > 1 && features.membershipsV2 ? (
                  <Tooltip multiline label="Your membership makes rewards worth more!">
                    <Stack gap={0}>
                      <Text
                        size="md"
                        style={{ fontSize: 20 }}
                        fw={700}
                        className={selectedBuzzConfig.classNames?.gradientText}
                      >
                        Rewards Multiplier: {rewardsMultiplier}x
                      </Text>
                    </Stack>
                  </Tooltip>
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
              </Group>
              {loadingRewards || multipliersLoading ? (
                <Center py="xl">
                  <Loader />
                </Center>
              ) : (
                <RewardsList
                  rewards={rewards.filter((reward) => reward.accountType === selectedAccountType)}
                  accountType={selectedAccountType}
                  onAccountTypeChange={setSelectedAccountType}
                />
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
          {features.creatorComp && <DailyCreatorCompReward buzzAccountType={selectedAccountType} />}
          {selectedAccountType === 'green' && (
            <Alert color="yellow" title="Green Creator Program Temporarily Disabled">
              <Text>
                The Green Creator Program is temporarily disabled and will return in at a later
                date. In the meantime, you can still earn and use Green Buzz for other activities on
                the platform.
              </Text>
            </Alert>
          )}
          {selectedAccountType === 'yellow' && <CreatorProgramV2 />}
          {selectedAccountType === 'red' && <GetPaid />}
        </Stack>
      </Container>
    </>
  );
}
