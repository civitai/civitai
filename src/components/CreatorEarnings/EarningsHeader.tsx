import {
  Alert,
  Center,
  Grid,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconMinus,
  IconInfoCircle,
} from '@tabler/icons-react';
import { ArcElement, Chart as ChartJS, Legend, Tooltip as ChartTooltip } from 'chart.js';
import { Doughnut } from 'react-chartjs-2';
import { useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import { numberWithCommas } from '~/utils/number-helpers';
import type { EarningSource, SourceMixRow } from '~/server/schema/creator-earnings.schema';

ChartJS.register(ArcElement, ChartTooltip, Legend);

const SOURCE_LABELS: Record<EarningSource, string> = {
  creatorsTip: 'Generation tips',
  tipConfirm: 'Direct tips',
  ea: 'Early Access',
  bounty: 'Bounties',
  other: 'Other',
};

const SOURCE_COLORS: Record<EarningSource, string> = {
  creatorsTip: '#f59f00',
  tipConfirm: '#fab005',
  ea: '#228be6',
  bounty: '#40c057',
  other: '#868e96',
};

function TrendBadge({ current, prior }: { current: number; prior: number }) {
  if (prior === 0 && current === 0) {
    return (
      <Group gap={4}>
        <IconMinus size={16} />
        <Text size="sm" c="dimmed">
          No prior month
        </Text>
      </Group>
    );
  }
  if (prior === 0) {
    return (
      <Group gap={4} c="green">
        <IconArrowUpRight size={16} />
        <Text size="sm">First earnings this month</Text>
      </Group>
    );
  }
  const delta = (current - prior) / prior;
  const pct = Math.round(Math.abs(delta) * 100);
  if (Math.abs(delta) < 0.005) {
    return (
      <Group gap={4} c="dimmed">
        <IconMinus size={16} />
        <Text size="sm">Flat vs prior month</Text>
      </Group>
    );
  }
  const Icon = delta > 0 ? IconArrowUpRight : IconArrowDownRight;
  const color = delta > 0 ? 'green' : 'red';
  return (
    <Group gap={4} c={color}>
      <Icon size={16} />
      <Text size="sm">
        {pct}% vs prior month ({numberWithCommas(prior)} Buzz)
      </Text>
    </Group>
  );
}

export function EarningsHeader() {
  const { data: earnings, isLoading: earningsLoading } = trpc.creator.getEarningsThisMonth.useQuery(
    {}
  );
  const { data: sourceMix = [], isLoading: mixLoading } = trpc.creator.getSourceMix.useQuery({
    window: '30d',
  });

  const chartData = useMemo(() => buildChartData(sourceMix), [sourceMix]);
  const hasMixData = sourceMix.some((r) => r.buzz > 0);

  if (earningsLoading) {
    return (
      <Paper p="lg" radius="md" withBorder>
        <Center py="xl">
          <Loader />
        </Center>
      </Paper>
    );
  }

  if (!earnings) {
    return (
      <Paper p="lg" radius="md" withBorder>
        <Alert color="yellow">Earnings data is temporarily unavailable.</Alert>
      </Paper>
    );
  }

  const { totalBuzz, usdEquivalent } = earnings.currentMonth;
  const monthLabel = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  return (
    <Paper p="lg" radius="md" withBorder>
      <Grid>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Stack gap="xs">
            <Group justify="space-between" align="baseline">
              <Title order={2}>Your earnings</Title>
              <Text c="dimmed" size="sm">
                {monthLabel}
              </Text>
            </Group>
            <Group align="baseline" gap="sm">
              <Title order={1} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {numberWithCommas(totalBuzz)}
              </Title>
              <Text c="dimmed" size="lg">
                Buzz
              </Text>
            </Group>
            <Tooltip
              label="Estimated value based on Civitai's internal exchange rate. Actual cash-out value may differ."
              multiline
              w={260}
            >
              <Group gap={4} c="dimmed" style={{ width: 'fit-content', cursor: 'help' }}>
                <Text size="sm">≈ ${usdEquivalent.toFixed(2)} (est.)</Text>
                <IconInfoCircle size={14} />
              </Group>
            </Tooltip>
            <TrendBadge current={totalBuzz} prior={earnings.priorMonth.totalBuzz} />
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Stack gap="xs">
            <Text fw={600}>How your earnings break down (30d)</Text>
            {mixLoading ? (
              <Center py="xl">
                <Loader size="sm" />
              </Center>
            ) : hasMixData ? (
              <Group gap="lg" align="center" wrap="nowrap">
                <div style={{ width: 140, height: 140, flexShrink: 0 }}>
                  <Doughnut
                    data={chartData}
                    options={{
                      cutout: '60%',
                      plugins: { legend: { display: false }, tooltip: { enabled: true } },
                      maintainAspectRatio: false,
                    }}
                  />
                </div>
                <Stack gap={4} style={{ flex: 1 }}>
                  {sourceMix
                    .filter((r) => r.buzz > 0)
                    .map((r) => (
                      <Group key={r.source} justify="space-between" gap="xs">
                        <Group gap="xs">
                          <span
                            aria-hidden
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: 2,
                              background: SOURCE_COLORS[r.source],
                              display: 'inline-block',
                            }}
                          />
                          <Text size="sm">{SOURCE_LABELS[r.source]}</Text>
                        </Group>
                        <Text size="sm" c="dimmed" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {r.pct}%
                        </Text>
                      </Group>
                    ))}
                </Stack>
              </Group>
            ) : (
              <Text c="dimmed" size="sm">
                No earnings activity in the last 30 days.
              </Text>
            )}
          </Stack>
        </Grid.Col>
      </Grid>
    </Paper>
  );
}

function buildChartData(rows: SourceMixRow[]) {
  const positive = rows.filter((r) => r.buzz > 0);
  return {
    labels: positive.map((r) => SOURCE_LABELS[r.source]),
    datasets: [
      {
        data: positive.map((r) => r.buzz),
        backgroundColor: positive.map((r) => SOURCE_COLORS[r.source]),
        borderWidth: 0,
      },
    ],
  };
}
