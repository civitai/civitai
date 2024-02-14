import { Line } from 'react-chartjs-2';
import {
  CategoryScale,
  Chart as ChartJS,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
  Colors,
  Legend,
  ChartOptions,
} from 'chart.js';
import dayjs from 'dayjs';
import { trpc } from '~/utils/trpc';
import { useBuzzDashboardStyles } from '~/components/Buzz/buzz.styles';
import { useMemo } from 'react';
import { Currency, StripeConnectStatus } from '@prisma/client';
import { Paper, Stack, Title, Text } from '@mantine/core';
import { constants } from '~/server/common/constants';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ChartTooltip,
  Colors,
  Legend
);

export const EarlyAccessRewards = () => {
  const { data: userStripeConnect } = trpc.userStripeConnect.get.useQuery();
  const { data: modelVersions = [], isLoading } =
    trpc.modelVersion.earlyAccessModelVersionsOnTimeframe.useQuery(
      { timeframe: 14 },
      {
        enabled: userStripeConnect?.status === StripeConnectStatus.Approved,
      }
    );

  const { classes, theme } = useBuzzDashboardStyles();
  const labelColor = theme.colorScheme === 'dark' ? theme.colors.gray[0] : theme.colors.dark[5];

  const options = useMemo<ChartOptions<'line'>>(
    () => ({
      aspectRatio: 3,
      responsive: true,
      scales: {
        y: {
          title: {
            display: true,
            text: 'Unique downloads',
            color: labelColor,
          },
          suggestedMin: 0,
          ticks: {
            stepSize: 1,
            color: labelColor,
          },
        },
        x: {
          ticks: {
            color: labelColor,
          },
        },
      },
      plugins: {
        legend: {
          labels: {
            boxWidth: 10,
            boxHeight: 10,
            borderRadius: 5,
            useBorderRadius: true,
            color: labelColor,
          },
        },
        title: {
          display: false,
        },
      },
    }),
    [theme.colorScheme]
  );

  const labels = useMemo(() => {
    const data = [];
    const today = dayjs().startOf('day');
    let day = today.subtract(14, 'day');
    while (day.isBefore(today)) {
      data.push(day.format('YYYY-MM-DD'));
      day = day.add(1, 'day');
    }

    return data;
  }, []);

  const datasets = useMemo(() => {
    return modelVersions.map((modelVersion) => {
      return {
        label: `${modelVersion.modelName} - ${modelVersion.modelVersionName}`,
        data: (modelVersion.meta?.earlyAccessDownloadData ?? []).map((data) => ({
          x: data.date,
          y: data.downloads,
        })),
      };
    });
  }, [modelVersions]);

  if (
    isLoading ||
    modelVersions.length === 0 ||
    !modelVersions.some((mv) => (mv.meta?.earlyAccessDownloadData?.length ?? 0) > 0) ||
    userStripeConnect?.status !== StripeConnectStatus.Approved
  ) {
    return null;
  }

  return (
    <Paper withBorder className={classes.tileCard} h="100%">
      <Stack p="md">
        <Title order={3}>Your early access models</Title>
        <Stack spacing={0}>
          <Text>
            As a member of the Civitai Creators Program, your models in early access will award you
            buzz per unique download.
          </Text>
          <Text>
            Each unique download will award you{' '}
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={constants.creatorsProgram.rewards.earlyAccessUniqueDownload}
            />
          </Text>
        </Stack>
        <Line
          options={options}
          data={{
            labels,
            datasets,
          }}
        />
      </Stack>
    </Paper>
  );
};
