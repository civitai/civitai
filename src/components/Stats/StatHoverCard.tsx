import { HoverCard, Text } from '@mantine/core';
import type { ReactNode } from 'react';

type StatHoverCardProps = {
  label: string;
  value: number;
  /** When set, the dropdown shows this note instead of the numeric value (hidden metric). */
  message?: string;
  children: ReactNode;
};

export function StatHoverCard({ label, value, message, children }: StatHoverCardProps) {
  return (
    <HoverCard shadow="sm" withArrow withinPortal>
      <HoverCard.Target>{children}</HoverCard.Target>
      <HoverCard.Dropdown px="xs" pt={4} pb={6}>
        <Text size="xs" fw={500} ta="center">
          {label}
        </Text>
        {message ? (
          <Text size="xs" c="dimmed" ta="center" maw={200}>
            {message}
          </Text>
        ) : (
          <Text size="sm" fw={700} ta="center">
            {value.toLocaleString()}
          </Text>
        )}
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
