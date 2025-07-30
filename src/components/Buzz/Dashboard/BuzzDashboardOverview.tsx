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
import { BuzzTopUpCard } from '~/components/Buzz/BuzzTopUpCard';
import { formatDate } from '~/utils/date-helpers';
import { capitalize, getDisplayName } from '~/utils/string-helpers';
import { getAccountTypeLabel } from '~/utils/buzz';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { hexToRgbOpenEnded } from '~/utils/mantine-css-helpers';
import classes from '~/components/Buzz/buzz.module.scss';
import Link from 'next/link';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { GetTransactionsReportSchema } from '~/server/schema/buzz.schema';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip);

const options = {
  aspectRatio: 1.4,
  responsive: true,
  plugins: {
    title: {
      display: false,
    },
    legend: {
      display: true,
      position: 'top' as const,
      labels: {
        usePointStyle: true,
        padding: 20,
      },
    },
  },
  scales: {
    x: {
      stacked: false, // Show bars side by side instead of stacked
      grid: {
        display: false,
      },
    },
    y: {
      stacked: false, // Show bars side by side instead of stacked
      beginAtZero: true,
      grid: {
        color: 'rgba(0, 0, 0, 0.1)',
      },
    },
  },
  elements: {
    bar: {
      borderRadius: 4,
    },
  },
};

const INCLUDE_DESCRIPTION = [TransactionType.Reward, TransactionType.Purchase];

const getAccountTypeDescription = (accountType: BuzzSpendType): string => {
  switch (accountType) {
    case 'yellow':
      return 'Legacy Buzz purchased via Memberships or our store. Can still be purchased via Gift-Cards.';
    case 'blue':
      return 'Free Buzz earned from viewing ads or completing daily challenges.';
    case 'green':
      return 'Green Buzz purchased with credit cards. Can only be used for safe-for-work content.';
    case 'red':
      return 'Red Buzz purchased with crypto. Can be used for NSFW content and all other site features.';
    default:
      return 'Buzz for various platform activities.';
  }
};

const getAccountTypeUsages = (accountType: BuzzSpendType): string[] => {
  switch (accountType) {
    case 'yellow':
      return ['Tips', 'Generation', 'Training', 'Creator Club', 'Bounties'];
    case 'blue':
      return ['Generation', 'Training'];
    case 'green':
      return ['Generation (SFW only)', 'Training (SFW only)', 'Tips', 'Creator Club'];
    case 'red':
      return ['Generation (including NSFW)', 'Training', 'Tips', 'Creator Club', 'Bounties'];
    default:
      return [];
  }
};

export const BuzzDashboardOverview = ({
  accountId,
  selectedAccountType,
}: {
  accountId: number;
  selectedAccountType?: BuzzSpendType;
}) => {
  // Use the selected account type for transactions, defaulting to 'user'
  const currentAccountType = selectedAccountType || 'yellow';
  const currentAccountTypeLabel: string = getAccountTypeLabel(currentAccountType);

  const transactionData = useBuzzTransactions(accountId, currentAccountType);
  const buzzConfig = useBuzzCurrencyConfig(currentAccountType);

  const [reportFilters, setReportFilters] = React.useState<GetTransactionsReportSchema>({
    window: 'day',
    accountType: currentAccountType ? currentAccountType : 'yellow',
  });

  // Update report filters when account type changes
  React.useEffect(() => {
    setReportFilters((prev) => ({
      ...prev,
      accountType: currentAccountType ? currentAccountType : 'yellow',
    }));
  }, [currentAccountType]);

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

  const datasets = useMemo(() => {
    const accountTypeLabel = currentAccountTypeLabel;
    const buzzColor = buzzConfig.color;
    const buzzColorRgb = hexToRgbOpenEnded(buzzColor);

    return [
      {
        label: `${accountTypeLabel} Gained`,
        data: report.reduce((acc, d) => {
          return {
            ...acc,
            [formatDate(d.date, viewingHourly ? 'HH:mm' : 'MMM-DD')]:
              d.accounts.find((a) => a.accountType === currentAccountType)?.gained ?? 0,
          };
        }, {}),
        borderColor: buzzColor,
        backgroundColor: `rgba(${buzzColorRgb}, 0.5)`, // 50% opacity for gains - more prominent
        borderWidth: 2,
      },
      {
        label: `${accountTypeLabel} Spent`,
        data: report.reduce((acc, d) => {
          return {
            ...acc,
            [formatDate(d.date, viewingHourly ? 'HH:mm' : 'MMM-DD')]:
              d.accounts.find((a) => a.accountType === currentAccountType)?.spent ?? 0,
          };
        }, {}),
        borderColor: `rgba(${buzzColorRgb}, 0.5)`, // 50% opacity for border
        backgroundColor: `rgba(${buzzColorRgb}, 0.2)`, // 20% opacity for background - less prominent
        borderWidth: 1,
      },
    ];
  }, [report, viewingHourly, currentAccountType, currentAccountTypeLabel, buzzConfig]);

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
                <Title order={3}>Current {currentAccountTypeLabel} Buzz</Title>
                <Group mb="sm">
                  <UserBuzz
                    key={currentAccountType}
                    accountId={accountId}
                    textSize="xl"
                    withAbbreviation={false}
                    accountTypes={[currentAccountType]}
                  />

                  <Popover width={350} withArrow withinPortal shadow="sm">
                    <Popover.Target>
                      <IconInfoCircle size={20} style={{ cursor: 'pointer' }} />
                    </Popover.Target>
                    <Popover.Dropdown>
                      <Stack>
                        <Group wrap="nowrap">
                          <Text>
                            <Text component="span" fw="bold" c={buzzConfig.color}>
                              <IconBolt
                                color={buzzConfig.color}
                                style={{
                                  fill: buzzConfig.fill,
                                  display: 'inline',
                                }}
                                size={16}
                              />
                              {currentAccountTypeLabel} Buzz:
                            </Text>{' '}
                            {getAccountTypeDescription(currentAccountType)}
                          </Text>
                        </Group>
                        {getAccountTypeUsages(currentAccountType).length > 0 && (
                          <List>
                            {getAccountTypeUsages(currentAccountType).map((usage, index) => (
                              <List.Item key={index}>{usage}</List.Item>
                            ))}
                          </List>
                        )}

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
                {currentAccountType === 'yellow' && (
                  <BuzzTopUpCard
                    accountId={accountId}
                    variant="banner"
                    message={`Need more ${currentAccountTypeLabel} Buzz?`}
                    showBalance={false}
                    btnLabel="Top up"
                  />
                )}

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
                  <Text c={buzzConfig.color} size="xs">
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
            <Title order={3}>Recent {currentAccountTypeLabel} Transactions</Title>
            <Anchor component={Link} href="/user/transactions" size="xs">
              <Group gap={2}>
                <IconArrowRight size={18} />
                <span>View all</span>
              </Group>
            </Anchor>
            {transactions.length ? (
              <ScrollArea.Autosize mah={480} mt="md" key={currentAccountType}>
                <Stack gap={8} mr={14}>
                  {transactions.map((transaction, index) => {
                    const { amount, date } = transaction;

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
                          <Text c={buzzConfig.color}>
                            <Group gap={2} wrap="nowrap">
                              <IconBolt
                                size={16}
                                color={buzzConfig.color}
                                style={{ fill: buzzConfig.fill }}
                              />
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
