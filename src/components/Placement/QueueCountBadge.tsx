import { Badge, Tooltip } from '@mantine/core';
import type { MantineSize } from '@mantine/core';
import { queueCountBadgeShape } from '~/components/Placement/queue-count-badge.shape';

/**
 * How many rows are waiting, as a badge.
 *
 * 🔴 `circle` fits ONE character, not two. It is `width: var(--badge-height)` with 2px of inline
 * padding — 14px of text at size `sm` — so "72" renders as "7…" and "50+" as "5…". The shape rule
 * lives in `queueCountBadgeShape` so it can be tested against the counts that break it; a render
 * test passing a single digit is green either way.
 *
 * The two ways a number can be incomplete are kept apart because they mean different things to the
 * reader:
 * - `truncated` — a floor. The caller only counted one page and there may be more ("50+" from a
 *   `nextCursor`).
 * - `max` — a cap. The caller knows the true number and it is too wide to draw ("99+" in a menu).
 */
export function QueueCountBadge({
  count,
  truncated = false,
  max,
  color = 'yellow',
  size = 'sm',
  ml,
  tooltip,
}: {
  count: number;
  /** There may be more than `count` — renders a `+`. */
  truncated?: boolean;
  /** Above this, render `max+` instead of the number. */
  max?: number;
  color?: string;
  size?: MantineSize;
  ml?: number;
  /** Hover text saying what is counted; wraps at a fixed width. */
  tooltip?: string;
}) {
  const shape = queueCountBadgeShape(count, { truncated, max });
  if (!shape) return null;

  const badge = (
    <Badge
      size={size}
      color={color}
      variant="filled"
      ml={ml}
      circle={shape.circle}
      px={shape.circle ? undefined : 6}
      // Both call sites are flex rows, where the badge is the item with the least content and so
      // the first to be squeezed below its own width.
      style={{ flexShrink: 0 }}
    >
      {shape.label}
    </Badge>
  );
  if (!tooltip) return badge;
  return (
    <Tooltip label={tooltip} multiline w={220} withArrow>
      {badge}
    </Tooltip>
  );
}
