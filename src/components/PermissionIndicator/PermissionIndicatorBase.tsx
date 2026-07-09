import type { GroupProps } from '@mantine/core';
import { Box, Group, List, Popover, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import React from 'react';

/**
 * Shared visual primitive behind every permission indicator on the site.
 *
 * Renders a horizontal strip of square, color-coded, tooltipped permission
 * badges (green = allowed, red = denied), wrapped in a Popover whose
 * dropdown lists the same permissions in human-readable form. Consumers
 * (PermissionIndicator for Models, Model3DPermissionIndicator for 3D
 * models) supply their domain-specific `badges` + `explanation` so the
 * visual stays consistent across surfaces while each domain keeps its own
 * vocabulary.
 */
export type PermissionBadge = {
  label: string;
  icon: React.ReactNode;
  allowed: boolean;
  /** Set to false to hide this badge entirely (e.g. mod-only badges for non-mods). */
  visible?: boolean;
};

export type PermissionIndicatorBaseProps = {
  badges: PermissionBadge[];
  /** Map of "human-readable capability" → granted. Rendered as the popover list. */
  explanation: Record<string, boolean>;
  /** Heading shown above the popover list. Defaults to the Model wording. */
  popoverTitle?: string;
  /** Pixel size of each square icon badge. */
  size?: number;
  /** When true and every badge is allowed, render an italic "None" suffix. */
  showNone?: boolean;
} & Omit<GroupProps, 'size'>;

export const PermissionIndicatorBase = ({
  badges,
  explanation,
  popoverTitle = 'This model permits users to:',
  size = 24,
  gap = 4,
  showNone = false,
  ...props
}: PermissionIndicatorBaseProps) => {
  const theme = useMantineTheme();
  const visibleBadges = badges.filter((b) => b.visible !== false);

  return (
    <Popover withArrow withinPortal>
      <Popover.Target>
        <Group gap={gap} style={{ cursor: 'pointer' }} wrap="nowrap" {...props}>
          {visibleBadges.map(({ label, icon, allowed }, i) => (
            <Tooltip key={i} label={label} withArrow withinPortal position="top">
              <Box
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: size,
                  height: size,
                  borderRadius: theme.radius.sm,
                  backgroundColor: allowed ? 'rgba(64, 192, 87, 0.2)' : 'rgba(250, 82, 82, 0.2)',
                  color: allowed ? theme.colors.green[4] : theme.colors.red[4],
                }}
              >
                {icon}
              </Box>
            </Tooltip>
          ))}
          {showNone && visibleBadges.every((b) => b.allowed) && (
            <Text fs="italic" size="xs">
              None
            </Text>
          )}
        </Group>
      </Popover.Target>
      <Popover.Dropdown>
        <Text fw={500}>{popoverTitle}</Text>
        <List
          size="xs"
          styles={{
            itemIcon: { marginRight: 4, paddingTop: 2 },
          }}
        >
          {Object.entries(explanation).map(([permission, allowed], i) => (
            <List.Item
              key={i}
              icon={
                allowed ? (
                  <IconCheck style={{ color: 'green' }} size={12} stroke={4} />
                ) : (
                  <IconX style={{ color: 'red' }} size={12} stroke={3} />
                )
              }
            >
              {permission}
            </List.Item>
          ))}
        </List>
      </Popover.Dropdown>
    </Popover>
  );
};
