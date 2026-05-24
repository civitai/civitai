import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconMinus,
  IconCircleOff,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { trpc } from '~/utils/trpc';
import { numberWithCommas } from '~/utils/number-helpers';
import type { ModelTrend } from '~/server/schema/creator-earnings.schema';

const PAGE_SIZE = 25;

const TYPE_OPTIONS = [
  { value: 'all', label: 'All types' },
  { value: 'LORA', label: 'LoRA' },
  { value: 'Checkpoint', label: 'Checkpoint' },
  { value: 'TextualInversion', label: 'Textual Inversion' },
  { value: 'Hypernetwork', label: 'Hypernetwork' },
  { value: 'LoCon', label: 'LoCon' },
  { value: 'DoRA', label: 'DoRA' },
  { value: 'Other', label: 'Other' },
];

function TrendIcon({ trend }: { trend: ModelTrend }) {
  switch (trend) {
    case 'up':
      return <IconArrowUpRight size={16} color="var(--mantine-color-green-6)" />;
    case 'down':
      return <IconArrowDownRight size={16} color="var(--mantine-color-red-6)" />;
    case 'dead':
      return <IconCircleOff size={16} color="var(--mantine-color-gray-6)" />;
    case 'flat':
    default:
      return <IconMinus size={16} color="var(--mantine-color-gray-6)" />;
  }
}

export function PerModelTable() {
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const { data: rows = [], isLoading } = trpc.creator.getModelPerformance.useQuery({
    window: '30d',
    sortBy: 'buzzEarned',
  });

  const filtered = useMemo(() => {
    if (typeFilter === 'all') return rows;
    return rows.filter((r) => r.modelType === typeFilter);
  }, [rows, typeFilter]);

  const totalBuzz = useMemo(() => filtered.reduce((acc, r) => acc + r.buzzEarned, 0), [filtered]);
  const visible = filtered.slice(0, visibleCount);

  if (isLoading) {
    return (
      <Paper p="lg" radius="md" withBorder>
        <Center py="xl">
          <Loader />
        </Center>
      </Paper>
    );
  }

  if (rows.length === 0) {
    return (
      <Paper p="lg" radius="md" withBorder>
        <Alert color="blue">
          Your earnings dashboard will populate once your published models start being used.{' '}
          <Text component="a" href="https://education.civitai.com" c="blue" td="underline">
            Learn more
          </Text>
        </Alert>
      </Paper>
    );
  }

  return (
    <Paper p="lg" radius="md" withBorder>
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Title order={3}>Your models — performance (30d)</Title>
          <Group gap="sm">
            <Select
              size="sm"
              data={TYPE_OPTIONS}
              value={typeFilter}
              onChange={(v) => {
                setTypeFilter(v ?? 'all');
                setVisibleCount(PAGE_SIZE);
              }}
              aria-label="Filter by type"
              w={180}
            />
          </Group>
        </Group>
        <Table striped highlightOnHover withTableBorder>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Model</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th style={{ textAlign: 'right' }}>Jobs (30d)</Table.Th>
              <Table.Th style={{ textAlign: 'right' }}>Buzz earned</Table.Th>
              <Table.Th>Trend</Table.Th>
              <Table.Th>Early Access</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visible.map((r) => (
              <Table.Tr key={r.modelId}>
                <Table.Td>
                  <Text
                    component="a"
                    href={`/models/${r.modelId}`}
                    fw={500}
                    c="blue"
                    td="underline"
                  >
                    {r.modelName}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" c="dimmed">
                    {r.modelType}
                  </Text>
                </Table.Td>
                <Table.Td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {numberWithCommas(r.jobsCount)}
                </Table.Td>
                <Table.Td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {numberWithCommas(r.buzzEarned)}
                </Table.Td>
                <Table.Td>
                  <TrendIcon trend={r.trend} />
                </Table.Td>
                <Table.Td>
                  {r.eaEnabled ? (
                    <Badge color="blue" variant="light">
                      Enabled
                    </Badge>
                  ) : (
                    <Text size="sm" c="dimmed">
                      Off
                    </Text>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            Showing {visible.length} of {filtered.length} models · {numberWithCommas(totalBuzz)}{' '}
            Buzz total
          </Text>
          {visible.length < filtered.length && (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
            >
              Show more
            </Button>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          Buzz earned per model is the sum of <code>creatorsTip</code> across generation jobs that
          used the model in the last 30 days. Direct tips, Early Access purchases, and bounties are
          aggregated user-level in the header. Per-model attribution of EA and tips is planned for
          Phase B.
        </Text>
      </Stack>
    </Paper>
  );
}
