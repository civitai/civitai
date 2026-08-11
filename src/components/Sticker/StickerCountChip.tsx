import type { BadgeProps, ButtonProps } from '@mantine/core';
import { Button, Text, Tooltip } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import clsx from 'clsx';

/**
 * The sticker entry chip, shared by the image detail view and feed cards so the
 * empty state is written once rather than once per surface.
 *
 * A count of zero reads as an invitation rather than a fact: the word instead of
 * the number, and the place button's colour instead of the reaction row's, so
 * "stickers +" is one affordance rather than a nought beside a plus. Only the
 * detail view ever passes zero — a card with no stickers renders nothing at all,
 * because a card offers no way to place one and would be advertising an action
 * it does not have.
 *
 * Deliberately just the button: each surface wraps it in whatever its own row
 * needs — `Button.Group` beside the plus on the detail view, nothing on a card —
 * so sharing the chip does not hand either surface the other's markup.
 */
export function StickerCountChip({
  count,
  revealed,
  tooltip,
  onClick,
  buttonProps,
  className,
}: {
  count: number;
  revealed: boolean;
  tooltip: string;
  onClick: (event: React.MouseEvent) => void;
  // Whatever the surface's `ReactionSettingsProvider` hands its reaction
  // buttons, so the chip picks up the row's styling without knowing the row.
  buttonProps?: Omit<ButtonProps, 'onClick'> & BadgeProps;
  className?: string;
}) {
  const empty = count === 0;

  return (
    <Tooltip label={tooltip} withArrow>
      <Button
        size="compact-sm"
        radius="xl"
        variant={empty || revealed ? 'light' : 'subtle'}
        color={empty ? 'yellow' : 'gray'}
        onClick={onClick}
        leftSection={<IconSticker size={16} />}
        className={clsx(className)}
        {...buttonProps}
      >
        <Text size="xs" fw={600}>
          {empty ? 'stickers' : count}
        </Text>
      </Button>
    </Tooltip>
  );
}
