import { Badge } from '@mantine/core';
import type { MantineSize } from '@mantine/core';

/**
 * How many rows are waiting, as a badge.
 *
 * Three surfaces count the same queue — the user menu entry, the settings
 * card's button, and the queue page's own tab — and each had grown its own copy
 * of the same two rules. They are collected here because the second rule is not
 * obvious and was rediscovered by each copy:
 *
 * 🔴 `circle` fixes the badge to a one- or two-character disc, so a truncated
 * count clips its own `+`: "50+" renders as "5…". A plus-suffixed number needs
 * the pill and its own padding, a plain one wants the disc.
 *
 * A zero renders nothing at all rather than a "0" disc — a badge saying zero
 * reads as a broken badge, not as an empty queue, and the surfaces here are
 * asking someone to go and look at something.
 *
 * The two ways a number can be incomplete are kept apart because they mean
 * different things to the reader:
 * - `truncated` — a floor. The caller only counted one page and there may be
 *   more ("50+" from a `nextCursor`).
 * - `max` — a cap. The caller knows the true number and it is too wide to draw
 *   ("99+" in a menu).
 */
export function QueueCountBadge({
  count,
  truncated = false,
  max,
  color = 'yellow',
  size = 'sm',
  ml,
}: {
  count: number;
  /** There may be more than `count` — renders a `+`. */
  truncated?: boolean;
  /** Above this, render `max+` instead of the number. */
  max?: number;
  color?: string;
  size?: MantineSize;
  ml?: number;
}) {
  if (!count) return null;

  const capped = max !== undefined && count > max;
  const withPlus = truncated || capped;
  const label = capped ? `${max}+` : truncated ? `${count}+` : `${count}`;

  return (
    <Badge
      size={size}
      color={color}
      variant="filled"
      ml={ml}
      circle={!withPlus}
      px={withPlus ? 6 : undefined}
    >
      {label}
    </Badge>
  );
}
