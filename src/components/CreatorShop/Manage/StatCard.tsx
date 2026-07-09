import { Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import type { ReactNode } from 'react';

export function StatCard({
  label,
  value,
  icon,
  color = 'gray',
  sub,
}: {
  label: string;
  value: number | string;
  icon: ReactNode;
  color?: string;
  sub?: ReactNode;
}) {
  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      style={{
        backgroundColor: `var(--mantine-color-${color}-light)`,
        borderColor: `var(--mantine-color-${color}-outline)`,
      }}
    >
      <Group gap="sm" wrap="nowrap" align="center">
        <ThemeIcon variant="filled" radius="md" size={40} color={color}>
          {icon}
        </ThemeIcon>
        <Stack gap={0} className="min-w-0">
          <Text size="xs" c="dimmed" lineClamp={1}>
            {label}
          </Text>
          <Text
            size="lg"
            fw={700}
            className="whitespace-nowrap"
            style={{ color: `var(--mantine-color-${color}-light-color)` }}
          >
            {value}
          </Text>
          {sub && (
            <Text size="xs" c="dimmed" lineClamp={1}>
              {sub}
            </Text>
          )}
        </Stack>
      </Group>
    </Paper>
  );
}
