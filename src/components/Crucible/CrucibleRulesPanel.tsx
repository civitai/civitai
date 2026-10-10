import { Paper, Stack, Text, Title } from '@mantine/core';
import { IconBook } from '@tabler/icons-react';
import { CRUCIBLE_ONE_PRIZE_RULE } from '~/utils/crucible-helpers';

type CrucibleRule = { label: string; value: string; visible?: boolean };

export function CrucibleRulesPanel({ rules }: { rules: CrucibleRule[] }) {
  return (
    <Paper className="rounded-lg p-6" bg="dark.6">
      <Title order={5} className="mb-4 flex items-center gap-2 uppercase tracking-wider text-white">
        <IconBook size={16} />
        Rules
      </Title>
      <Stack gap="md">
        {[...rules, { label: 'One Prize Per Creator', value: CRUCIBLE_ONE_PRIZE_RULE }]
          .filter((rule) => rule.visible !== false)
          .map((rule) => (
            <div key={rule.label}>
              <Text size="xs" c="dimmed" tt="uppercase" mb={4}>
                {rule.label}
              </Text>
              <Text size="sm" fw={600} c="white">
                {rule.value}
              </Text>
            </div>
          ))}
      </Stack>
    </Paper>
  );
}
