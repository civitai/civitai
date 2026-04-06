import {
  Anchor,
  Center,
  Group,
  List,
  Paper,
  Popover,
  ScrollArea,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
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
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useIsMobile } from '~/hooks/useIsMobile';
import { abbreviateValue } from '~/components/Buzz/chart-defaults';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, ChartTooltip);

const INCLUDE_DESCRIPTION = [TransactionType.Reward, TransactionType.Purchase];

const getAccountTypeDescription = (accountType: BuzzSpendType): string => {
  switch (accountType) {
    case 'yellow':
      return 'Yellow Buzz can be used for NSFW content and all other site features.';
    case 'blue':
      return 'Free Buzz earned from viewing ads or completing daily challenges.';
    case 'green':
      return 'Green Buzz purchased with credit cards. Can only be used for safe-for-work content.';
    // case 'red': // temporarily disabled
    //   return 'Red Buzz purchased with crypto. Can be used for NSFW content and all other site features.';
    default:
      return 'Buzz for various platform activities.';
  }
};

const getAccountTypeUsages = (accountType: BuzzSpendType): string[] => {
  switch (accountType) {
    case 'yellow':
      return ['Generation (including NSFW)', 'Training', 'Tips', 'Creator Club', 'Bounties'];
    case 'blue':
      return ['Generation', 'Training'];
    case 'green':
      return ['Generation (SFW only)', 'Training (SFW only)', 'Tips', 'Creator Club'];
    // case 'red': // temporarily disabled
    //   return ['Generation (including NSFW)', 'Training', 'Tips', 'Creator Club', 'Bounties'];
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
  const features = useFeatureFlags();
  // Use the selected account type for transactions, defaulting to 'yellow'
  const currentAccountType = selectedAccountType || 'yellow';
  const currentAccountTypeLabel: string = getAccountTypeLabel(currentAccountType);

  const transactionData = useBuzzTransactions(accountId, currentAccountType);
  const buzzConfig = useBuzzCurrencyConfig(currentAccountType);
  const mobile = useIsMobile({ breakpoint: 'sm' });
  const [reportFilters, setReportFilters] = React.useState<GetTransactionsReportSchema>({
    window: 'day',
    accountType: currentAccountType,
  });

  // Update report filters when account type changes
  React.useEffect(() => {
    setReportFilters((prev) => ({
      ...prev,
      accountType: currentAccountType,
    }));
  }, [currentAccountType]);

  const { report, isLoading, isRefetching } = useTransactionsReport(reportFilters, {
    enabled: true,
  });

  const isLoadingReport = isLoading || isRefetching;
  const viewingHourly = reportFilters.window === 'hour';

  const options = React.useMemo(() => {
    return {
      aspectRatio: mobile ? 1 : 1.4,
      responsive: true,
      plugins: {
        title: { display: false },
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
          stacked: false,
          grid: { display: false },
          ticks: {
            color: buzzConfig.color,
            maxTicksLimit: mobile ? 5 : 8,
            autoSkip: true,
          },
        },
        y: {
          stacked: false,
          beginAtZero: true,
          ticks: {
            color: buzzConfig.color,
            callback: abbreviateValue,
          },
          grid: { color: 'rgba(128, 128, 128, 0.1)' },
        },
      },
      elements: {
        bar: { borderRadius: 4 },
      },
    };
  }, [buzzConfig.color, mobile]);

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
    <div
      className={classes.dashboardGrid}
      style={{ '--grid-cols': 'minmax(0, 7fr) minmax(0, 5fr)' } as React.CSSProperties}
    >
      <div>
        <Stack h="100%">
          <Paper p="lg" radius="md" className={classes.tileCard} h="100%">
            <Stack gap="sm" h="100%">
              <Stack gap={0} mb="auto">
                <Group justify="space-between" align="flex-start" wrap="wrap" mb="sm">
                  <Stack gap={4}>
                    <h3 className="text-xl font-bold" style={{ margin: 0 }}>
                      Current {currentAccountTypeLabel} Buzz
                    </h3>
                    <Group gap="sm" align="center" wrap="nowrap">
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
                              rel="nofollow noreferrer"
                              href="https://education.civitai.com/civitais-guide-to-on-site-currency-buzz-⚡/#types-of-buzz"
                              size="xs"
                            >
                              Learn more
                            </Anchor>
                          </Stack>
                        </Popover.Dropdown>
                      </Popover>
                    </Group>
                  </Stack>
                  {/* Top Up Card - hidden on mobile */}
                  {currentAccountType === 'yellow' && !features.isGreen && (
                    <div className="hidden md:block">
                      <BuzzTopUpCard
                        accountId={accountId}
                        variant="banner"
                        message={`Need more ${currentAccountTypeLabel} Buzz?`}
                        showBalance={false}
                        btnLabel="Top up"
                      />
                    </div>
                  )}
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
                  mt="xs"
                  mb={-8}
                />
              </Stack>
              {isLoadingReport ? (
                <Skeleton height={413} mt="sm" radius="sm" />
              ) : report.length > 0 ? (
                <div style={{ position: 'relative', overflow: 'hidden', width: '100%' }}>
                  <Text
                    c={buzzConfig.color}
                    size="xs"
                    style={{
                      position: 'absolute',
                      top: 0,
                      right: 0,
                      zIndex: 1,
                      opacity: 0.7,
                    }}
                  >
                    All times are UTC
                  </Text>
                  <Bar
                    key={reportFilters.window}
                    options={options}
                    data={{
                      labels,
                      datasets,
                    }}
                  />
                </div>
              ) : (
                <Center>
                  <Text c="dimmed" mt="md">
                    We found no data on the provided timeframe.
                  </Text>
                </Center>
              )}
            </Stack>
          </Paper>
        </Stack>
      </div>
      <div className={classes.dashboardGridConstrained}>
        <Paper
          radius="md"
          className={`${classes.tileCard} ${classes.dashboardGridConstrainedInner}`}
          style={{
            display: 'grid',
            gridTemplateRows: 'auto 1fr',
            overflow: 'hidden',
            padding: 'var(--mantine-spacing-lg) var(--mantine-spacing-lg) 0',
          }}
        >
          <Group justify="space-between" align="center" wrap="nowrap" mb="sm">
            <h3 className="text-xl font-bold" style={{ margin: 0 }}>
              Recent {currentAccountTypeLabel} Transactions
            </h3>
            <Anchor
              component={Link}
              href={`/user/transactions?accountType=${currentAccountType}`}
              size="xs"
              style={{ whiteSpace: 'nowrap' }}
            >
              View all
            </Anchor>
          </Group>
          {transactionData.isLoading ? (
            <Stack gap={12} pr="lg" pt={4}>
              {Array.from({ length: 8 }).map((_, i) => (
                <Group key={i} justify="space-between" wrap="nowrap">
                  <Stack gap={4} style={{ flex: 1 }}>
                    <Skeleton height={14} width="60%" radius="sm" />
                    <Skeleton height={10} width="30%" radius="sm" />
                  </Stack>
                  <Skeleton height={20} width={70} radius="sm" />
                </Group>
              ))}
            </Stack>
          ) : transactions.length ? (
            <div
              className={classes.transactionsScrollWrapper}
              style={{
                marginLeft: 'calc(-1 * var(--mantine-spacing-lg))',
                marginRight: 'calc(-1 * var(--mantine-spacing-lg))',
                borderTop:
                  '1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
              }}
            >
              <ScrollArea style={{ minHeight: 0, height: '100%' }} key={currentAccountType}>
                <div style={{ paddingBottom: 'var(--mantine-spacing-lg)' }}>
                  {transactions.map((transaction, index) => {
                    const { amount, date } = transaction;

                    return (
                      <Group
                        key={index + '@' + date.toISOString()}
                        justify="space-between"
                        wrap="nowrap"
                        align="flex-start"
                        py="xs"
                        px="lg"
                        style={{
                          borderBottom:
                            '1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))',
                        }}
                      >
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
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          ) : (
            <Text c="dimmed" mt="md">
              No transactions yet.
            </Text>
          )}
        </Paper>
      </div>
    </div>
  );
};
