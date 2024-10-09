import { TransactionType } from '~/server/schema/buzz.schema';
import {
  Center,
  Grid,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { UserBuzz } from '~/components/User/UserBuzz';
import { Bar } from 'react-chartjs-2';
import React, { useCallback, useMemo } from 'react';
import {
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
} from 'chart.js';
import { formatDate } from '~/utils/date-helpers';
import { useBuzzTransactions } from '~/components/Buzz/useBuzz';
import { IconArrowRight, IconBolt } from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { getDisplayName } from '~/utils/string-helpers';
import { useBuzzDashboardStyles } from '../buzz.styles';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip);

const options = {
  aspectRatio: 1.4,
  plugins: {
    title: {
      display: false,
    },
  },
};

const INCLUDE_DESCRIPTION = [TransactionType.Reward, TransactionType.Purchase];

export const BuzzDashboardOverview = ({ accountId }: { accountId: number }) => {
  const { classes, theme } = useBuzzDashboardStyles();
  // Right now, sadly, we neeed to use two separate queries for user and generation transactions.
  // If this ever changes, that'd be awesome. But for now, we need to do this.
  const mainBuzzTransactions = useBuzzTransactions(accountId, 'user');
  const generationBuzzTransactions = useBuzzTransactions(accountId, 'generation');
  const [transactionType, setTransactionType] = React.useState<'user' | 'generation'>('user');

  const transactions = useMemo(() => {
    return transactionType === 'user'
      ? mainBuzzTransactions.transactions
      : generationBuzzTransactions.transactions;
  }, [transactionType, mainBuzzTransactions.transactions, generationBuzzTransactions.transactions]);

  const { dates, format } = useMemo(() => {
    const dailyFormat = 'MMM-DD';
    const daily = [
      ...new Set(
        [...mainBuzzTransactions.transactions, ...generationBuzzTransactions.transactions]
          .sort((a, b) => {
            return a.date.getTime() - b.date.getTime();
          })
          .map((t) => formatDate(t.date, dailyFormat))
      ),
    ]
      .reverse()
      .slice(0, 10)
      .reverse();
    const hourlyFormat = 'MMM-DD h:00';
    const hourly = [
      ...new Set(
        [...mainBuzzTransactions.transactions, ...generationBuzzTransactions.transactions].map(
          (t) => formatDate(t.date, hourlyFormat)
        )
      ),
    ]
      .slice(0, 24)
      .reverse(); // Max 24 hours

    return daily.length > 3
      ? { dates: daily, format: dailyFormat }
      : { dates: hourly, format: hourlyFormat };
  }, [mainBuzzTransactions.transactions, generationBuzzTransactions.transactions]);

  // Last 7 days of data pretty much.

  const getTransactionTotalByDate = useCallback(
    (data: { date: Date; amount: number }[], date: string, positive = true) => {
      return data
        .filter(
          (t) => formatDate(t.date, format) === date && (positive ? t.amount > 0 : t.amount < 0)
        )
        .reduce((acc, t) => acc + t.amount, 0);
    },
    [format]
  );

  const datasets = useMemo(
    () => [
      {
        label: 'Yellow Gains',
        data: dates.map((date) => {
          return getTransactionTotalByDate(mainBuzzTransactions.transactions, date);
        }),
        borderColor: theme.colors.yellow[7],
        backgroundColor: theme.colors.yellow[7],
        stack: 'gains',
      },
      {
        label: 'Blue Gains',
        data: dates.map((date) => {
          return getTransactionTotalByDate(generationBuzzTransactions.transactions, date);
        }),
        borderColor: theme.colors.blue[7],
        backgroundColor: theme.colors.blue[7],
        stack: 'gains',
      },
      {
        label: 'Yellow Spent',
        data: dates.map((date) => {
          return getTransactionTotalByDate(mainBuzzTransactions.transactions, date, false);
        }),
        borderColor: theme.colors.red[7],
        backgroundColor: theme.colors.red[7],
        stack: 'spending',
      },
      {
        label: 'Blue Spent',
        data: dates.map((date) => {
          return getTransactionTotalByDate(generationBuzzTransactions.transactions, date, false);
        }),
        borderColor: theme.colors.violet[7],
        backgroundColor: theme.colors.violet[7],
        stack: 'spending',
      },
    ],
    [
      dates,
      theme,
      getTransactionTotalByDate,
      mainBuzzTransactions.transactions,
      generationBuzzTransactions.transactions,
    ]
  );

  if (mainBuzzTransactions.transactionsLoading || generationBuzzTransactions.transactionsLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  return (
    <Grid>
      <Grid.Col xs={12} md={7} sm={6}>
        <Stack h="100%">
          <Paper withBorder p="lg" radius="md" className={classes.tileCard} h="100%">
            <Stack spacing="xl" h="100%">
              <Stack spacing={0} mb="auto">
                <Title order={3}>Current Buzz</Title>
                <Group>
                  <UserBuzz
                    accountId={accountId}
                    accountType="user"
                    textSize="xl"
                    withAbbreviation={false}
                  />
                  <UserBuzz
                    accountId={accountId}
                    accountType="generation"
                    textSize="xl"
                    withAbbreviation={false}
                  />
                </Group>
              </Stack>
              <Bar
                options={options}
                data={{
                  labels: dates,
                  datasets,
                }}
              />
            </Stack>
          </Paper>
        </Stack>
      </Grid.Col>
      <Grid.Col xs={12} md={5} sm={6}>
        <Paper
          withBorder
          p="lg"
          radius="md"
          h="100%"
          className={classes.tileCard}
          style={{ flex: 1 }}
        >
          <Stack spacing="xs">
            <Title order={3}>Recent Transactions</Title>
            <SegmentedControl
              value={transactionType}
              onChange={(v) => setTransactionType(v as 'user' | 'generation')}
              data={[
                { label: 'Yellow', value: 'user' },
                { label: 'Blue', value: 'generation' },
              ]}
            />
            <Text component="a" variant="link" href={`/user/transactions`} size="xs">
              <Group spacing={2}>
                <IconArrowRight size={18} />
                <span>View all</span>
              </Group>
            </Text>
            {transactions.length ? (
              <ScrollArea.Autosize maxHeight={400} mt="md">
                <Stack spacing={8} mr={14}>
                  {transactions.map((transaction) => {
                    const { amount, date } = transaction;
                    const isDebit = amount < 0;

                    return (
                      <Stack key={date.toISOString()} spacing={4}>
                        <Group position="apart" noWrap align="flex-start">
                          <Stack spacing={0}>
                            <Text size="sm" weight="500" lh={1.2}>
                              {INCLUDE_DESCRIPTION.includes(transaction.type) &&
                              transaction.description ? (
                                <>{transaction.description}</>
                              ) : (
                                <>{getDisplayName(TransactionType[transaction.type])}</>
                              )}
                            </Text>
                            <Text size="xs" color="dimmed">
                              <DaysFromNow date={date} />
                            </Text>
                          </Stack>
                          <Text color={isDebit ? 'red' : 'green'}>
                            <Group spacing={2} noWrap>
                              <IconBolt size={16} fill="currentColor" />
                              <Text size="lg" sx={{ fontVariantNumeric: 'tabular-nums' }} span>
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
  );
};
