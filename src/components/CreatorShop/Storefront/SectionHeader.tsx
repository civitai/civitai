import { Group, Stack, Text, ThemeIcon } from '@mantine/core';
import type { ReactNode } from 'react';
import type { TablerIcon } from '~/components/CreatorShop/section-meta';
import classes from './SectionHeader.module.scss';

// Shared storefront section heading, sized to match the profile overview
// headers: a ringed icon + title, with optional subtitle and a right-aligned
// slot for filters/sort.
export function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  right,
}: {
  icon: TablerIcon;
  title: string;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="center" wrap="wrap" gap="xs">
      <Group gap={10} align="center" wrap="nowrap">
        <ThemeIcon size="xl" radius="md" variant="light" color="yellow">
          <Icon size={24} />
        </ThemeIcon>
        <Stack gap={0}>
          <Text className={classes.title}>{title}</Text>
          {subtitle && (
            <Text size="sm" c="dimmed" className={classes.subtitle}>
              {subtitle}
            </Text>
          )}
        </Stack>
      </Group>
      {right}
    </Group>
  );
}
