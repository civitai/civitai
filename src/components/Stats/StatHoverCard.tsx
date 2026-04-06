import { HoverCard, Text } from '@mantine/core';
import type { ReactNode } from 'react';

type StatHoverCardProps = {
  label: string;
  value: number;
  children: ReactNode;
};

export function StatHoverCard({ label, value, children }: StatHoverCardProps) {
  return (
    <HoverCard shadow="sm" withArrow withinPortal>
      <HoverCard.Target>{children}</HoverCard.Target>
      <HoverCard.Dropdown px="xs" pt={4} pb={6}>
        <Text size="xs" fw={500} ta="center">
          {label}
        </Text>
        <Text size="sm" fw={700} ta="center">
          {value.toLocaleString()}
        </Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
