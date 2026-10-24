import { Badge, Group, Paper, Stack, Text, Title } from '@mantine/core';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { summarizeTrainingRun } from '~/utils/training/run-summary';

export function TrainingRunSummary({
  modelName,
  versionName,
  trainingDetails,
}: {
  modelName: string;
  versionName: string;
  trainingDetails: TrainingDetailsObj | undefined | null;
}) {
  const { architecture, continuedFromEpoch, continuedFromVersionName, rows } =
    summarizeTrainingRun(trainingDetails);

  return (
    <Paper shadow="sm" radius="sm" p="md" withBorder>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={2}>
            <Title order={5} lineClamp={2}>
              {modelName}
            </Title>
            <Text size="sm" c="dimmed" lineClamp={1}>
              {versionName}
            </Text>
          </Stack>
          <Group gap={6} wrap="nowrap">
            {!!architecture && <Badge variant="light">{architecture}</Badge>}
            {continuedFromEpoch !== null && continuedFromEpoch > 0 && (
              <Badge variant="light" color="violet">
                Continued from epoch #{continuedFromEpoch}
                {continuedFromVersionName ? ` of ${continuedFromVersionName}` : ''}
              </Badge>
            )}
          </Group>
        </Group>

        {rows.length > 0 && (
          <Group gap="lg" wrap="wrap">
            {rows.map((row) => (
              <Stack key={row.label} gap={0}>
                <Text size="xs" c="dimmed">
                  {row.label}
                </Text>
                <Text size="sm">{row.value}</Text>
              </Stack>
            ))}
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
