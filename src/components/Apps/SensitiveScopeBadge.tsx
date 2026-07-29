import { Badge, type BadgeProps, Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

/**
 * Small reusable warning indicator rendered next to a SENSITIVE block scope
 * (see `SENSITIVE_BLOCK_SCOPES` in block-scope.constants). Shared by the mod
 * review modal, the consent/grant prompt, and the per-app "granted permissions"
 * panels so the "this permission is elevated-risk" emphasis reads identically
 * everywhere. Presentation only — it never affects whether a scope is granted.
 */
export function SensitiveScopeBadge({ size = 'sm', ...props }: Omit<BadgeProps, 'children'>) {
  return (
    <Tooltip
      multiline
      w={260}
      label="Sensitive permission — this can spend your Buzz, read your private data, or write data other users see. Review it carefully."
    >
      <Badge
        size={size}
        color="orange"
        variant="filled"
        leftSection={<IconAlertTriangle size={11} />}
        data-testid="sensitive-scope-badge"
        {...props}
      >
        Sensitive
      </Badge>
    </Tooltip>
  );
}
