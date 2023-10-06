import {
  Text,
  Center,
  Container,
  Grid,
  Loader,
  Paper,
  Stack,
  useMantineTheme,
  ScrollArea,
  Title,
  Group,
  createStyles,
  Badge,
  Divider,
  Button,
} from '@mantine/core';
import React, { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import dayjs from 'dayjs';
import { UserBuzz } from '~/components/User/UserBuzz';
import {
  IconArrowLeft,
  IconArrowRight,
  IconBolt,
  IconCoin,
  IconCoins,
  IconMoneybag,
  IconUsers,
} from '@tabler/icons-react';
import Link from 'next/link';
import { formatDate } from '~/utils/date-helpers';
import { TransactionType } from '~/server/schema/buzz.schema';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip);

export const options = {
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
  resolver: async ({ session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.buzz) {
      return { notFound: true };
    }
  },
});

const useStyles = createStyles((theme) => ({
  card: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
}));

export default function UserWallet() {
  const currentUser = useCurrentUser();
  const theme = useMantineTheme();
  const { classes } = useStyles();

  const { data: { transactions = [] } = {}, isLoading } = trpc.buzz.getUserTransactions.useQuery({
    limit: 200,
  });

  const transactionsReversed = useMemo(() => [...(transactions ?? [])].reverse(), [transactions]);

  const starterBuzzAmount = (transactions ?? []).reduce((acc, transaction) => {
    return acc - transaction.amount;
  }, currentUser?.balance ?? 0);

  const items: Record<string, number> = useMemo(() => {
    if (!transactions) return {};

    let start = starterBuzzAmount;

    return transactionsReversed.reduce((acc, transaction) => {
      const updated = {
        ...acc,
        [dayjs(transaction.date).format('DD/MM/YYYY')]: start + transaction.amount,
      };

      start += transaction.amount;

      return updated;
    }, {});
  }, [transactions]);

  const dateCount = Object.keys(items).length;
  // Last 7 days of data pretty much.
  const labels = Object.keys(items).slice(Math.max(0, dateCount - 7), dateCount);
  const data = Object.values(items).slice(Math.max(0, dateCount - 7), dateCount);

  return (
    <Container size="lg">
      <Stack spacing="xl">
        <Title order={1}>My Wallet</Title>

        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : (
          <Grid>
            <Grid.Col xs={12} md={7}>
              <Stack>
                <Paper withBorder p="lg" radius="md" className={classes.card}>
                  <Stack spacing={0}>
                    <Title order={3}>Current Buzz</Title>
                    <UserBuzz textSize="xl" user={currentUser} withAbbreviation={false} />
                  </Stack>
                  <Stack spacing="xs" mt="xl">
                    <Line
                      options={options}
                      data={{
                        labels,
                        datasets: [
                          {
                            label: 'Buzz Amount',
                            data,
                            borderColor: theme.colors.yellow[7],
                            backgroundColor: theme.colors.yellow[7],
                          },
                        ],
                      }}
                    />
                  </Stack>
                </Paper>
                <Paper withBorder radius="md" p="xl" className={classes.card}>
                  <Group position="apart">
                    <Title order={3} size={24}>
                      Lifetime Buzz
                    </Title>
                    <Stack>
                      <Text
                        size="xl"
                        style={{ fontSize: 32, fontWeight: 700, lineHeight: '22px' }}
                        color="yellow.7"
                      >
                        TODO
                      </Text>
                    </Stack>
                  </Group>
                </Paper>
              </Stack>
            </Grid.Col>
            <Grid.Col xs={12} md={5}>
              <Paper withBorder p="lg" radius="md" h="100%" className={classes.card}>
                <Stack spacing={0}>
                  <Title order={3}>Recent Transactions</Title>
                  <Text component="a" variant="link" href={`/user/transactions`} size="xs">
                    <Group spacing={2}>
                      <IconArrowRight size={18} />
                      <span>View all</span>
                    </Group>
                  </Text>
                  {transactions.length ? (
                    <ScrollArea.Autosize maxHeight={400} mt="md">
                      <Stack spacing={8}>
                        {transactions.map((transaction) => {
                          const { amount, date, fromUser, toUser, description } = transaction;
                          const isDebit = amount < 0;

                          return (
                            <Stack key={date.toISOString()} spacing={4}>
                              <Group position="apart">
                                <Stack spacing={0}>
                                  <Text size="sm" weight="500">
                                    {TransactionType[transaction.type]}
                                  </Text>
                                  <Text size="xs">
                                    <DaysFromNow date={date} />
                                  </Text>
                                </Stack>
                                <Text color={isDebit ? 'red' : 'green'}>
                                  <Group spacing={2}>
                                    <IconBolt size={16} fill="currentColor" />
                                    <Text
                                      size="lg"
                                      sx={{ fontVariantNumeric: 'tabular-nums' }}
                                      span
                                    >
                                      {amount.toLocaleString()}
                                    </Text>
                                  </Group>
                                </Text>
                              </Group>
                            </Stack>
                          );
                        })}
                      </Stack>
                    </ScrollArea.Autosize>
                  ) : (
                    <Text color="dimmed" mt="md">
                      No transactions yet.
                    </Text>
                  )}
                </Stack>
              </Paper>
            </Grid.Col>
          </Grid>
        )}

        <EarningBuzz />
      </Stack>
    </Container>
  );
}

const useEarningBuzzCardStyles = createStyles((theme) => ({
  card: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[0],
  },
}));
const EarningBuzz = () => {
  const { classes } = useEarningBuzzCardStyles();
  const data = [
    {
      key: 'referrals',
      icon: <IconUsers size={32} />,
      title: 'Referrals',
      description: 'You & your friends can earn more buzz!',
      href: '/user/referrals',
      btnLabel: 'Invite a friend',
    },
    {
      key: 'bounties',
      icon: <IconMoneybag size={32} />,
      title: 'Bounties',
      description: 'Submit work to a bounty to win buzz',
      href: '/bounties',
      btnLabel: 'Learn more',
    },
    {
      key: 'purchase',
      icon: <IconCoin size={32} />,
      title: 'Purchase',
      description: 'Purchase buzz directly',
      href: '/purchase/buzz',
      btnLabel: 'Buy now',
    },
    {
      key: 'tips',
      icon: <IconCoins size={32} />,
      title: 'Get tipped',
      description: 'Create awesome content!',
      href: '/images',
      btnLabel: 'Learn more',
    },
  ];
  return (
    <Stack spacing={20}>
      <Stack spacing={4}>
        <Title order={2}>Earning Buzz</Title>
        <Text>Need some buzz? Here&rsquo;s how you can earn it</Text>
      </Stack>
      <Grid gutter={20}>
        {data.map((item) => (
          <Grid.Col key={item.key} xs={12} md={3}>
            <Paper withBorder className={classes.card} h="100%">
              <Stack spacing={4} p="md" align="center" h="100%">
                <Center>{item.icon}</Center>
                <Text weight={500} size="xl">
                  {item.title}
                </Text>
                <Text color="dimmed" align="center">
                  {item.description}
                </Text>
                <Divider />
                <Button mt="auto" component="a" href={item.href} w="100%">
                  {item.btnLabel}
                </Button>
              </Stack>
            </Paper>
          </Grid.Col>
        ))}
      </Grid>
      <Paper withBorder className={classes.card} h="100%">
        <Stack p="md">
          <Title order={3}>Other ways you&rsquo;ll earn some buzz</Title>
        </Stack>
      </Paper>
    </Stack>
  );
};
