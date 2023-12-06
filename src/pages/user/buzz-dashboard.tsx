import {
  Center,
  Container,
  createStyles,
  Divider,
  Grid,
  Group,
  keyframes,
  Loader,
  Paper,
  RingProgress,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { Currency } from '@prisma/client';
import { IconArrowRight, IconBolt, IconInfoCircle } from '@tabler/icons-react';
import {
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
} from 'chart.js';
import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { EarningBuzz, SpendingBuzz } from '~/components/Buzz/FeatureCards/FeatureCards';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Meta } from '~/components/Meta/Meta';
import { UserBuzz } from '~/components/User/UserBuzz';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TransactionType } from '~/server/schema/buzz.schema';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { BuzzDashboardOverview } from '~/components/Buzz/Dashboard/CurrentBuzz';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip);

const options = {
  aspectRatio: 2.5,
  plugins: {
    legend: {
      display: false,
    },
    title: {
      display: false,
    },
  },
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.buzz) {
      return { notFound: true };
    }
  },
});

const moveBackground = keyframes({
  '0%': {
    backgroundPosition: '0% 50%',
  },
  '50%': {
    backgroundPosition: '100% 50%',
  },
  '100%': {
    backgroundPosition: '0% 50%',
  },
});

const pulse = keyframes({
  '0%': {
    stroke: '#FFD43B',
    opacity: 1,
  },
  '50%': {
    stroke: '#F59F00',
    opacity: 0.7,
  },
  '100%': {
    stroke: '#F08C00',
    opacity: 1,
  },
});

const useStyles = createStyles((theme) => ({
  lifetimeBuzzContainer: {
    border: `2px solid ${theme.colors.yellow[7]}`,
    background: theme.fn.linearGradient(45, theme.colors.yellow[4], theme.colors.yellow[1]),
    animation: `${moveBackground} 5s ease infinite`,
    backgroundSize: '200% 200%',
  },
  lifetimeBuzzBadge: {
    background: theme.colors.dark[6],
    borderRadius: '22px',
    padding: '10px 20px',
  },
  tileCard: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
  lifetimeBuzz: {
    animation: `${pulse} 1s ease-in-out infinite`,
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
        deIndex="noindex, nofollow"
      />
      <Container size="lg">
        <Stack spacing="xl">
          <Title order={1}>My Buzz Dashboard</Title>

          <BuzzDashboardOverview accountId={currentUser?.id as number} />

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

          <SpendingBuzz withCTA />
        </Stack>
      </Container>
    </>
  );
}
