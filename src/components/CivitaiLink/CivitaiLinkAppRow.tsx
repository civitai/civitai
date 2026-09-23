import { Center, Group, Stack, Text } from '@mantine/core';
import { IconPackages } from '@tabler/icons-react';
import clsx from 'clsx';
import classes from './civitai-link.module.scss';

export function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <Group
      gap={6}
      wrap="nowrap"
      px={10}
      py={4}
      className={clsx(!connected && classes.surfaceRaised)}
      bg={connected ? 'var(--mantine-color-success-light)' : undefined}
      style={{ borderRadius: 999, flexShrink: 0 }}
    >
      <div
        className="size-1.5 rounded-full"
        style={{
          background: connected ? 'var(--mantine-color-success-5)' : 'var(--mantine-color-dark-2)',
        }}
      />
      <Text fz={11} fw={600} c={connected ? 'success.5' : 'dimmed'}>
        {connected ? 'Connected' : 'Offline'}
      </Text>
    </Group>
  );
}

export function AppRow({
  name,
  meta,
  connected,
  onClick,
  actions,
}: {
  name: string;
  meta?: string;
  connected: boolean;
  onClick?: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <Group
      gap={12}
      wrap="nowrap"
      px={14}
      py={12}
      className={classes.surface}
      style={{ borderRadius: 'var(--mantine-radius-sm)', cursor: onClick ? 'pointer' : undefined }}
      onClick={onClick}
    >
      <Center
        w={34}
        h={34}
        className={classes.surfaceRaised}
        style={{ borderRadius: 'var(--mantine-radius-sm)', flexShrink: 0 }}
      >
        <IconPackages size={18} className={classes.neutralIcon} />
      </Center>
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Text fz="sm" fw={500} c="var(--mantine-color-bright)" lineClamp={1}>
          {name}
        </Text>
        {meta && (
          <Text fz="xs" c="dimmed" lineClamp={1}>
            {meta}
          </Text>
        )}
      </Stack>
      <StatusBadge connected={connected} />
      {actions}
    </Group>
  );
}
