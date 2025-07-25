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
  useMantineTheme,
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
import { BuzzTopUpCard } from '~/components/Buzz/BuzzTopUpCard';
import type { GetTransactionsReportSchema } from '~/server/schema/buzz.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import { formatDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import classes from '~/components/Buzz/buzz.module.scss';
import Link from 'next/link';

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
  const theme = useMantineTheme();
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
      <Grid.Col
        span={{
          base: 12,
          sm: 6,
          md: 7,
        }}
      >
        <Stack h="100%">
          <Paper p="lg" radius="md" className={classes.tileCard} h="100%">
            <Stack gap="xl" h="100%">
              <Stack gap={0} mb="auto">
                <Title order={3}>Current Buzz</Title>
                <Group mb="sm">
                  <UserBuzz
                    accountId={accountId}
                    textSize="xl"
                    withAbbreviation={false}
                    accountTypes={['user', 'fakered']}
                  />
                  <UserBuzz
                    accountId={accountId}
                    textSize="xl"
                    withAbbreviation={false}
                    accountTypes={['generation', 'green']}
                  />

                  <Popover width={350} withArrow withinPortal shadow="sm">
                    <Popover.Target>
                      <IconInfoCircle size={20} style={{ cursor: 'pointer' }} />
                    </Popover.Target>
                    <Popover.Dropdown>
                      <Stack>
                        <Group wrap="nowrap">
                          <Text>
                            <Text component="span" fw="bold" c="yellow.7">
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
                          <Text component="span" fw="bold" c="blue.4">
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
                          target="_blank"
                          href="https://education.civitai.com/civitais-guide-to-on-site-currency-buzz-⚡/#types-of-buzz"
                          size="xs"
                        >
                          Learn more
                        </Anchor>
                      </Stack>
                    </Popover.Dropdown>
                  </Popover>
                </Group>

                {/* Top Up Card - Show when buzz is low */}
                <BuzzTopUpCard
                  accountId={accountId}
                  variant="banner"
                  message="Need more Buzz?"
                  showBalance={false}
                  btnLabel="Top up"
                />

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
                    <Text c="dimmed" mt="md">
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
                  <Text c="yellow.7" size="xs">
                    All times are UTC
                  </Text>
                </>
              )}
            </Stack>
          </Paper>
        </Stack>
      </Grid.Col>
      <Grid.Col
        span={{
          base: 12,
          sm: 6,
          md: 5,
        }}
      >
        <Paper p="lg" radius="md" h="100%" className={classes.tileCard} style={{ flex: 1 }}>
          <Stack gap="xs">
            <Title order={3}>Recent Transactions</Title>
            <SegmentedControl
              value={transactionType}
              onChange={(v) => setTransactionType(v as 'user' | 'generation')}
              data={[
                { label: 'Yellow', value: 'user' },
                { label: 'Blue', value: 'generation' },
              ]}
            />
            <Anchor component={Link} href="/user/transactions" size="xs">
              <Group gap={2}>
                <IconArrowRight size={18} />
                <span>View all</span>
              </Group>
            </Anchor>
            {transactions.length ? (
              <ScrollArea.Autosize mah={480} mt="md" key={transactionType}>
                <Stack gap={8} mr={14}>
                  {transactions.map((transaction, index) => {
                    const { amount, date } = transaction;
                    const isDebit = amount < 0;

                    return (
                      <Stack key={index + '@' + date.toISOString()} gap={4}>
                        <Group justify="space-between" wrap="nowrap" align="flex-start">
                          <Stack gap={0}>
                            <Text size="sm" fw="500" lh={1.2}>
                              {INCLUDE_DESCRIPTION.includes(transaction.type) &&
                              transaction.description ? (
                                <>{transaction.description}</>
                              ) : (
                                <>{getDisplayName(TransactionType[transaction.type])}</>
                              )}
                            </Text>
                            <Text size="xs" c="dimmed">
                              <DaysFromNow date={date} />
                            </Text>
                          </Stack>
                          <Text c={isDebit ? 'red' : 'green'}>
                            <Group gap={2} wrap="nowrap">
                              <IconBolt size={16} fill="currentColor" />
                              <Text size="lg" style={{ fontVariantNumeric: 'tabular-nums' }} span>
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
              <Text c="dimmed" mt="md">
                No transactions yet.
              </Text>
            )}
          </Stack>
        </Paper>
      </Grid.Col>
    </Grid>
  );
};
