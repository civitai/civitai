import {
  Center,
  Container,
  createStyles,
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
import { Currency } from '@prisma/client';
import { IconInfoCircle } from '@tabler/icons-react';
import React from 'react';
import { EarningBuzz, SpendingBuzz } from '~/components/Buzz/FeatureCards/FeatureCards';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { BuzzDashboardOverview } from '~/components/Buzz/Dashboard/BuzzDashboardOverview';
import { StripeConnectCard } from '../../components/Account/StripeConnectCard';
import { OwnedBuzzWithdrawalRequestsPaged } from '../../components/Buzz/WithdrawalRequest/OwnedBuzzWithdrawalRequestsPaged';
import { EarlyAccessRewards } from '~/components/Buzz/Rewards/EarlyAccessRewards';
import { GeneratedImagesReward } from '~/components/Buzz/Rewards/GeneratedImagesRewards';
import { PurchasableRewards } from '~/components/PurchasableRewards/PurchasableRewards';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.buzz) {
      return { notFound: true };
    }
  },
});

const useStyles = createStyles((theme) => ({
  tileCard: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
}));

export default function UserBuzzDashboard() {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();

  const { data: rewards = [], isLoading: loadingRewards } = trpc.user.userRewardDetails.useQuery(
    undefined,
    {
      enabled: !!currentUser,
    }
  );

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

          <StripeConnectCard />
          <OwnedBuzzWithdrawalRequestsPaged />

          <EarningBuzz withCTA />

          <Paper withBorder className={classes.tileCard} h="100%">
            <Stack p="md">
              <Title order={3}>Other ways you can earn Buzz</Title>
              {loadingRewards ? (
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
                          <CurrencyBadge
                            w={100}
                            currency={Currency.BUZZ}
                            unitAmount={reward.awardAmount}
                          />
                          <Text>{reward.triggerDescription ?? reward.description}</Text>
                          {reward.tooltip && (
                            <Tooltip label={reward.tooltip} maw={250} multiline withArrow>
                              <IconInfoCircle size={20} style={{ flexShrink: 0 }} />
                            </Tooltip>
                          )}
                        </Group>
                        {reward.cap && (
                          <Group spacing={4}>
                            <Text color="dimmed" size="xs">
                              {hasAwarded
                                ? `⚡️ ${reward.awarded} / ${reward.cap.toLocaleString()} `
                                : `⚡️ ${reward.cap.toLocaleString()} `}{' '}
                              {reward.interval ?? 'day'}
                            </Text>
                            {hasAwarded && (
                              <RingProgress
                                size={30}
                                thickness={9}
                                sections={[
                                  {
                                    value: awardedAmountPercent * 100,
                                    color: awardedAmountPercent === 1 ? 'green' : 'yellow.7',
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
          <EarlyAccessRewards />
          <GeneratedImagesReward />
          <SpendingBuzz withCTA />
          <PurchasableRewards />
        </Stack>
      </Container>
    </>
  );
}
