import { BuzzAccountType, TransactionType } from '~/server/schema/buzz.schema';
import {
  Center,
  createStyles,
  Grid,
  Group,
  keyframes,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { UserBuzz } from '~/components/User/UserBuzz';
import { Line } from 'react-chartjs-2';
import React, { useMemo } from 'react';
import {
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
} from 'chart.js';
import { trpc } from '~/utils/trpc';
import { formatDate } from '~/utils/date-helpers';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Currency } from '@prisma/client';
import { numberWithCommas } from '~/utils/number-helpers';
import { IconArrowRight, IconBolt } from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { getDisplayName } from '~/utils/string-helpers';
import { useBuzzDashboardStyles } from '../buzz.styles';

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

const INCLUDE_DESCRIPTION = [TransactionType.Reward, TransactionType.Purchase];

export const BuzzDashboardOverview = ({
  accountId,
  accountType = 'User',
}: {
  accountId: number;
  accountType?: BuzzAccountType;
}) => {
  const { classes, theme } = useBuzzDashboardStyles();
  const { balance, lifetimeBalance, balanceLoading } = useBuzz(accountId, accountType);
  const { data: { transactions = [] } = {}, isLoading } = trpc.buzz.getAccountTransactions.useQuery(
    {
      limit: 200,
      accountId,
      accountType,
    }
  );

  const transactionsReversed = useMemo(() => [...(transactions ?? [])].reverse(), [transactions]);

  const starterBuzzAmount = (transactions ?? []).reduce((acc, transaction) => {
    return acc - transaction.amount;
  }, balance);

  const items: Record<string, number> = useMemo(() => {
    if (!transactions) return {};

    let start = starterBuzzAmount;

    return transactionsReversed.reduce((acc, transaction) => {
      const updated = {
        ...acc,
        [formatDate(transaction.date, 'MMM-DD')]: start + transaction.amount,
      };

      start += transaction.amount;

      return updated;
    }, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions]);

  const dateCount = Object.keys(items).length;
  // Last 7 days of data pretty much.
  const labels = Object.keys(items).slice(Math.max(0, dateCount - 7), dateCount);
  const data = Object.values(items).slice(Math.max(0, dateCount - 7), dateCount);

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  return (
    <Grid>
      <Grid.Col xs={12} md={7}>
        <Stack h="100%">
          <Paper withBorder p="lg" radius="md" className={classes.tileCard}>
            <Stack spacing={0}>
              <Title order={3}>Current Buzz</Title>
              <UserBuzz
                accountId={accountId}
                accountType={accountType}
                textSize="xl"
                withAbbreviation={false}
              />
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
          <Paper
            withBorder
            radius="md"
            p="xl"
            className={classes.lifetimeBuzzContainer}
            style={{ flex: 1, display: 'flex' }}
          >
            <Group position="apart" sx={{ flex: 1 }} noWrap>
              <Title order={3} size={22} color="yellow.8">
                Lifetime Buzz
              </Title>
              <Group className={classes.lifetimeBuzzBadge} spacing={2} noWrap>
                <CurrencyIcon currency={Currency.BUZZ} size={24} />
                {balanceLoading ? (
                  <Loader variant="dots" color="yellow.7" />
                ) : (
                  <Text
                    size="xl"
                    style={{ fontSize: 32, fontWeight: 700, lineHeight: '24px' }}
                    color="yellow.7"
                    className={classes.lifetimeBuzz}
                  >
                    {numberWithCommas(lifetimeBalance)}
                  </Text>
                )}
              </Group>
            </Group>
          </Paper>
        </Stack>
      </Grid.Col>
      <Grid.Col xs={12} md={5}>
        <Paper
          withBorder
          p="lg"
          radius="md"
          h="100%"
          className={classes.tileCard}
          style={{ flex: 1 }}
        >
          <Stack spacing={0}>
            <Title order={3}>Recent Transactions</Title>
            {accountType === 'User' && (
              <Text component="a" variant="link" href={`/user/transactions`} size="xs">
                <Group spacing={2}>
                  <IconArrowRight size={18} />
                  <span>View all</span>
                </Group>
              </Text>
            )}
            {transactions.length ? (
              <ScrollArea.Autosize maxHeight={400} mt="md">
                <Stack spacing={8}>
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
