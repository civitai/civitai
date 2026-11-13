import { Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import type { ReactNode } from 'react';

export function EventSectionHeading({
  icon: IconComponent,
  title,
  subtitle,
  color,
  children,
}: {
  icon: Icon;
  title: ReactNode;
  subtitle?: ReactNode;
  /** A team colour; the blue default suits sections that belong to no team. */
  color?: string;
  /** Controls aligned to the right of the heading. */
  children?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-end" gap="md">
      {/* The icon centres on the title line, not the title and subtitle together, so it stays put
          when a subtitle wraps on a phone. */}
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon
          size={40}
          radius="xl"
          variant="light"
          color={color ?? 'blue'}
          className="-mt-0.5 shrink-0"
        >
          <IconComponent size={22} />
        </ThemeIcon>
        <Stack gap={2}>
          <Title order={2}>{title}</Title>
          {subtitle && (
            <Text size="sm" c="dimmed">
              {subtitle}
            </Text>
          )}
        </Stack>
      </Group>
      {children}
    </Group>
  );
}
