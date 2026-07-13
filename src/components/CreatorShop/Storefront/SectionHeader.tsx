import { Group, ThemeIcon, Title } from '@mantine/core';
import type { ReactNode } from 'react';
import type { TablerIcon } from '~/components/CreatorShop/section-meta';

// Shared storefront section heading: a small ringed icon + title, with an
// optional right-aligned slot for filters/sort. Replaces the old accent bar.
export function SectionHeader({
  icon: Icon,
  title,
  right,
}: {
  icon: TablerIcon;
  title: string;
  right?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="center" wrap="wrap" gap="xs">
      <Group gap={8} align="center" wrap="nowrap">
        <ThemeIcon size={30} radius="md" variant="light" color="yellow">
          <Icon size={18} />
        </ThemeIcon>
        <Title order={4}>{title}</Title>
      </Group>
      {right}
    </Group>
  );
}
