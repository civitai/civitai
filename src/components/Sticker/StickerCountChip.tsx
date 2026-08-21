import type { BadgeProps, ButtonProps } from '@mantine/core';
import { Button, rgba, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { IconSticker } from '@tabler/icons-react';
import clsx from 'clsx';

/**
 * The invitation's tint, shared by the chip and the place button beside it so
 * the pair reads as one control.
 *
 * It has to be an inline style rather than `color="yellow"`: the surfaces that
 * mount these pass a `ReactionSettingsProvider` whose `buttonStyling` returns an
 * inline `style` with its own background, and an inline style beats the
 * `var(--button-bg)` class rule Mantine's `color` prop drives. A `color` prop
 * here computes a variable nothing reads.
 *
 * Mirrors the shape the reaction row already uses for "you did this" —
 * `rgba(colour[4], 0.4)` under white text — so this is the row's own visual
 * language in a different hue, not a second one.
 */
export function useStickerInviteStyle() {
  const theme = useMantineTheme();
  return { color: 'white', background: rgba(theme.colors.yellow[4], 0.4) };
}

/**
 * The sticker entry chip, shared by the image detail view and feed cards so the
 * empty state is written once rather than once per surface.
 *
 * A count of zero reads as an invitation rather than a fact: the word instead of
 * the number, under the place button's tint instead of the reaction row's. Only
 * the detail view ever passes zero — a card with no stickers renders nothing at
 * all, because a card offers no way to place one and would be advertising an
 * action it does not have.
 *
 * Deliberately just the button: each surface wraps it in whatever its own row
 * needs — `Button.Group` beside the plus on the detail view, nothing on a card —
 * so sharing the chip does not hand either surface the other's markup.
 */
export function StickerCountChip({
  count,
  revealed,
  showLabel,
  tooltip,
  ariaLabel,
  onClick,
  buttonProps,
  className,
}: {
  count: number;
  revealed: boolean;
  /** Spell out "3 stickers" rather than "3", where the row has room for it. */
  showLabel?: boolean;
  /** Omit for no tooltip at all — see the bar, which now says nothing on hover. */
  tooltip?: string;
  ariaLabel?: string;
  onClick: (event: React.MouseEvent) => void;
  // Whatever the surface's `ReactionSettingsProvider` hands its reaction
  // buttons, so the chip picks up the row's styling without knowing the row.
  buttonProps?: Omit<ButtonProps, 'onClick'> & BadgeProps;
  className?: string;
}) {
  const inviteStyle = useStickerInviteStyle();
  const empty = count === 0;

  // `className` last and merged: `buttonProps` is typed to carry one, and a
  // surface passing both would otherwise silently lose its own — including the
  // `pointer-events-auto` a feed card needs to be clickable inside its link.
  const {
    className: providedClassName,
    style: providedStyle,
    ...restButtonProps
  } = buttonProps ?? {};

  const chip = (
    <Button
      size="compact-sm"
      radius="xl"
      variant={empty || revealed ? 'light' : 'subtle'}
      color={empty ? 'yellow' : 'gray'}
      onClick={onClick}
      aria-label={ariaLabel}
      leftSection={<IconSticker size={16} />}
      {...restButtonProps}
      style={{ ...providedStyle, ...(empty ? inviteStyle : null) }}
      className={clsx(providedClassName, className)}
    >
      <Text size="xs" fw={600}>
        {empty
          ? 'stickers'
          : showLabel
          ? `${count} ${count === 1 ? 'sticker' : 'stickers'}`
          : count}
      </Text>
    </Button>
  );

  // No tooltip, no wrapper. The bar deliberately says nothing on hover now — the
  // free hint is a popover everyone can see, and a hover-only price line was
  // telling a phone nothing at all.
  return tooltip ? (
    <Tooltip label={tooltip} withArrow>
      {chip}
    </Tooltip>
  ) : (
    chip
  );
}
