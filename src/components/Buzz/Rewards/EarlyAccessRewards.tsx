import {
  Center,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import type { ChartOptions } from 'chart.js';
import {
  CategoryScale,
  Chart as ChartJS,
  Colors,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip as ChartTooltip,
} from 'chart.js';
import dayjs from '~/shared/utils/dayjs';
import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import classes from '~/components/Buzz/buzz.module.scss';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useUserPaymentConfiguration } from '~/components/UserPaymentConfiguration/util';
import { constants } from '~/server/common/constants';
import { StripeConnectStatus } from '~/server/common/enums';
import { Currency } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

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
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { userPaymentConfiguration } = useUserPaymentConfiguration();
  const { data: modelVersions = [], isLoading } =
    trpc.modelVersion.earlyAccessModelVersionsOnTimeframe.useQuery(
      { timeframe: 14 },
      {
        enabled: userPaymentConfiguration?.stripeAccountStatus === StripeConnectStatus.Approved,
      }
    );
  const labelColor = colorScheme === 'dark' ? theme.colors.gray[0] : theme.colors.dark[5];

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
    [colorScheme]
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
    return modelVersions
      .filter((mv) => (mv.meta?.earlyAccessDownloadData ?? []).length > 0)
      .map((modelVersion) => {
        return {
          label: `${modelVersion.modelName} - ${modelVersion.modelVersionName}`,
          data: (modelVersion.meta?.earlyAccessDownloadData ?? []).map((data) => ({
            x: data.date,
            y: data.downloads,
          })),
        };
      });
  }, [modelVersions]);

  if (userPaymentConfiguration?.stripeAccountStatus !== StripeConnectStatus.Approved) {
    return null;
  }

  return (
    <Paper withBorder className={classes.tileCard} h="100%">
      <Stack p="md">
        <Title order={3}>Your early access models</Title>
        <Stack gap={0}>
          <Text>
            As a member of the Civitai Creator Program, your models in early access will award you
            Buzz per unique download.
          </Text>
          <Text>
            Each unique download will award you{' '}
            <CurrencyBadge
              currency={Currency.BUZZ}
              unitAmount={constants.creatorsProgram.rewards.earlyAccessUniqueDownload}
            />
          </Text>
        </Stack>
        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : datasets.length === 0 ? (
          <Center>
            <Text c="dimmed">
              Whoops! Looks like we are still collecting data on your early access models on these
              past 14 days. Please check back later.
            </Text>
          </Center>
        ) : (
          <Line
            options={options}
            data={{
              labels,
              datasets,
            }}
          />
        )}
      </Stack>
    </Paper>
  );
};
