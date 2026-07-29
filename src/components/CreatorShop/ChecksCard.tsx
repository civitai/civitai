import { Group, Paper, Text } from '@mantine/core';
import { IconCircleCheck, IconCircleX, IconPointFilled } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { CREATOR_SHOP_BORDER } from '~/components/CreatorShop/creator-shop.constants';

// Bordered card with a header band (icon + title) shared by the pre-submit
// requirements list and the moderator's automated-checks panel.
export function ChecksCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <Paper withBorder radius="md" className="overflow-hidden">
      <Group
        gap={6}
        px="md"
        py="xs"
        align="center"
        style={{
          borderBottom: CREATOR_SHOP_BORDER,
          background: 'var(--mantine-color-default-hover)',
        }}
      >
        {icon}
        <Text size="sm" fw={600}>
          {title}
        </Text>
      </Group>
      {children}
    </Paper>
  );
}

// A single check row. `neutral` shows an up-front requirement (bullet, no verdict);
// `pass`/`fail` show the result. `emphasizeFail` reddens the label on failure.
export function CheckRow({
  state,
  label,
  detail,
  withBorder,
  emphasizeFail,
}: {
  state: 'neutral' | 'pass' | 'fail';
  label: string;
  detail?: string;
  withBorder?: boolean;
  emphasizeFail?: boolean;
}) {
  return (
    <Group
      gap={9}
      px="md"
      py={9}
      wrap="nowrap"
      align="center"
      style={{ borderBottom: withBorder ? CREATOR_SHOP_BORDER : undefined }}
    >
      {state === 'neutral' ? (
        <IconPointFilled size={10} color="var(--mantine-color-dimmed)" />
      ) : state === 'pass' ? (
        <IconCircleCheck size={16} color="var(--mantine-color-green-5)" />
      ) : (
        <IconCircleX size={16} color="var(--mantine-color-red-5)" />
      )}
      <Text size="sm" style={{ flex: 1 }} c={emphasizeFail && state === 'fail' ? 'red' : undefined}>
        {label}
      </Text>
      {detail && (
        <Text size="xs" c={state === 'pass' ? 'dimmed' : 'red'}>
          {detail}
        </Text>
      )}
    </Group>
  );
}
