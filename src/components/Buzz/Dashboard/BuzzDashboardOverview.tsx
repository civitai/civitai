import {
  Anchor,
  Center,
  Grid,
  Group,
  List,
  Loader,
  Paper,
  Popover,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
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
import { Bar } from 'react-chartjs-2';
import { useBuzzTransactions, useTransactionsReport } from '~/components/Buzz/useBuzz';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { UserBuzz } from '~/components/User/UserBuzz';
import { GetTransactionsReportSchema, TransactionType } from '~/server/schema/buzz.schema';
import { formatDate } from '~/utils/date-helpers';
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
  const [transactionType, setTransactionType] = React.useState<'user' | 'generation'>('user');
  const transactionData = useBuzzTransactions(accountId, transactionType);
  const [reportFilters, setReportFilters] = React.useState<GetTransactionsReportSchema>({
    window: 'day',
    accountType: ['User', 'Generation'],
  });

  const { report, isLoading, isRefetching } = useTransactionsReport(reportFilters, {
    enabled: true,
  });

  const isLoadingReport = isLoading || isRefetching;
  const viewingHourly = reportFilters.window === 'hour';

  const labels = useMemo(() => {
    return report.map((d) => formatDate(d.date, viewingHourly ? 'HH:mm' : 'MMM-DD'), true);
  }, [report, viewingHourly]);

  const transactions = useMemo(() => {
    return [...(transactionData?.transactions ?? [])].sort((a, b) => {
      return b.date.getTime() - a.date.getTime();
    });
  }, [transactionData.transactions]);

  const datasets = useMemo(
    () => [
      {
        label: 'Yellow Gains',
        data: report.reduce((acc, d) => {
          return {
            ...acc,
            [formatDate(d.date, viewingHourly ? 'HH:mm' : 'MMM-DD')]:
              d.accounts.find((a) => a.accountType === 'User')?.gained ?? 0,
          };
        }, {}),
        borderColor: theme.colors.yellow[7],
        backgroundColor: theme.colors.yellow[7],
        stack: 'gained',
      },
      {
        label: 'Blue Gains',
        data: report.reduce((acc, d) => {
          return {
            ...acc,
            [formatDate(d.date, viewingHourly ? 'HH:mm' : 'MMM-DD')]:
              d.accounts.find((a) => a.accountType === 'Generation')?.gained ?? 0,
          };
        }, {}),
        borderColor: theme.colors.blue[7],
        backgroundColor: theme.colors.blue[7],
        stack: 'gained',
      },
      {
        label: 'Yellow Spent',
        data: report.reduce((acc, d) => {
          return {
            ...acc,
            [formatDate(d.date, viewingHourly ? 'HH:mm' : 'MMM-DD')]:
              d.accounts.find((a) => a.accountType === 'User')?.spent ?? 0,
          };
        }, {}),
        borderColor: theme.colors.red[7],
        backgroundColor: theme.colors.red[7],
        stack: 'spending',
      },
      {
        label: 'Blue Spent',
        data: report.reduce((acc, d) => {
          return {
            ...acc,
            [formatDate(d.date, viewingHourly ? 'HH:mm' : 'MMM-DD')]:
              d.accounts.find((a) => a.accountType === 'Generation')?.spent ?? 0,
          };
        }, {}),
        borderColor: theme.colors.violet[7],
        backgroundColor: theme.colors.violet[7],
        stack: 'spending',
      },
    ],
    [theme, report, viewingHourly]
  );

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

                  <Popover width={350} withArrow withinPortal shadow="sm">
                    <Popover.Target>
                      <IconInfoCircle size={20} style={{ cursor: 'pointer' }} />
                    </Popover.Target>
                    <Popover.Dropdown>
                      <Stack>
                        <Group noWrap>
                          <Text>
                            <Text component="span" weight="bold" color="yellow.7">
                              <IconBolt
                                color="yellow.7"
                                style={{ fill: theme.colors.yellow[7], display: 'inline' }}
                                size={16}
                              />
                              Yellow Buzz:
                            </Text>{' '}
                            Either purchased or earned from Creator Compensation systems. Can be
                            used for:
                          </Text>
                        </Group>
                        <List>
                          <List.Item>Tips</List.Item>
                          <List.Item>Generation</List.Item>
                          <List.Item>Training</List.Item>
                          <List.Item>Creator Club</List.Item>
                          <List.Item>Bounties</List.Item>
                        </List>
                        <Text>
                          <Text component="span" weight="bold" color="blue.4">
                            <IconBolt
                              color="blue.4"
                              style={{ fill: theme.colors.blue[4], display: 'inline' }}
                              size={16}
                            />
                            Blue Buzz:
                          </Text>{' '}
                          Free Buzz earned from viewing ads or completing daily challenges. Can be
                          used for:
                        </Text>
                        <List>
                          <List.Item>Generation</List.Item>
                          <List.Item>Training</List.Item>
                        </List>

                        <Anchor
                          target="blank"
                          href="https://education.civitai.com/civitais-guide-to-on-site-currency-buzz-⚡/#types-of-buzz"
                          size="xs"
                        >
                          Learn more
                        </Anchor>
                      </Stack>
                    </Popover.Dropdown>
                  </Popover>
                </Group>
                <SegmentedControl
                  value={reportFilters.window}
                  onChange={(v) =>
                    setReportFilters({
                      ...reportFilters,
                      window: v as GetTransactionsReportSchema['window'],
                    })
                  }
                  data={[
                    { label: '24h', value: 'hour' },
                    { label: '7d', value: 'day' },
                    { label: 'Weekly', value: 'week' },
                    { label: '12m', value: 'month' },
                  ]}
                  mt="md"
                  mb="md"
                />
                {isLoadingReport && (
                  <Center>
                    <Loader />
                  </Center>
                )}

                {!isLoadingReport && !report.length && (
                  <Center>
                    <Text color="dimmed" mt="md">
                      We found no data on the provided timeframe.
                    </Text>
                  </Center>
                )}
              </Stack>
              {!isLoadingReport && report.length > 0 && (
                <>
                  <Bar
                    key={reportFilters.window}
                    options={options}
                    data={{
                      labels,
                      datasets,
                    }}
                  />
                  <Text color="yellow.7" size="xs">
                    All times are UTC
                  </Text>
                </>
              )}
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
              <ScrollArea.Autosize maxHeight={480} mt="md" key={transactionType}>
                <Stack spacing={8} mr={14}>
                  {transactions.map((transaction, index) => {
                    const { amount, date } = transaction;
                    const isDebit = amount < 0;

                    return (
                      <Stack key={index + '@' + date.toISOString()} spacing={4}>
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
            ) : transactionData.isLoading ? (
              <Center>
                <Loader />
              </Center>
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
