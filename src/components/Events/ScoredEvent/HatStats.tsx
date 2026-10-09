import { Text } from '@mantine/core';
import type { MantineColor } from '@mantine/core';
import {
  IconEye,
  IconHeart,
  IconHierarchy,
  IconMessageCircle,
  IconSticker,
} from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import clsx from 'clsx';
import { abbreviateNumber } from '~/utils/number-helpers';

/**
 * Every way a hat scores, with the icon and colour it wears wherever it appears: the How it works
 * tiles, a worn hat's popover and the viewer's hat cards.
 */
export const SCORE_WAYS = {
  views: { icon: IconEye, color: 'blue' },
  reactions: { icon: IconHeart, color: 'pink' },
  comments: { icon: IconMessageCircle, color: 'green' },
  stickers: { icon: IconSticker, color: 'yellow' },
  remixes: { icon: IconHierarchy, color: 'violet' },
} satisfies Record<string, { icon: Icon; color: MantineColor }>;

export type HatStatCounts = {
  points: number;
  impressions: number;
  reactions: number;
  /** Counted from scoring v2 on; until the server sends one, its tile shows a dash, not a 0. */
  comments?: number;
  remixes?: number;
};

/**
 * What a hat earned: its points large in its team's colour, beside the four ways that make them up.
 */
export function HatStats({
  stats,
  color,
  compact,
}: {
  stats: HatStatCounts;
  color?: string;
  /** A hat card's width rather than the popover's. */
  compact?: boolean;
}) {
  return (
    <div
      className={clsx('grid gap-1.5', compact ? 'grid-cols-[64px_1fr]' : 'grid-cols-[76px_1fr]')}
      data-testid="hat-stats"
    >
      <div
        className="flex min-w-0 flex-col items-center justify-center rounded-md bg-gray-1 px-1 py-1.5 dark:bg-dark-5"
        // A tint of the team colour over the tile's own grey, so it reads in both themes.
        style={
          color
            ? {
                backgroundImage: `linear-gradient(color-mix(in srgb, ${color} 16%, transparent), color-mix(in srgb, ${color} 16%, transparent))`,
              }
            : undefined
        }
        data-testid="hat-stat-points"
      >
        <Text
          fw={900}
          c={color}
          className={clsx('tabular-nums', compact ? 'text-xl' : 'text-[26px]')}
          lh={1.05}
        >
          {abbreviateNumber(stats.points)}
        </Text>
        <Text size="xs" c="dimmed">
          points
        </Text>
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-1.5">
        <WayStat way="views" value={stats.impressions} compact={compact} />
        <WayStat way="reactions" value={stats.reactions} compact={compact} />
        <WayStat way="comments" value={stats.comments} compact={compact} />
        <WayStat way="remixes" value={stats.remixes} compact={compact} />
      </div>
    </div>
  );
}

/** A card has no room for the words: there each way is its icon and number, the word its label. */
function WayStat({
  way,
  value,
  compact,
}: {
  way: keyof typeof SCORE_WAYS;
  value?: number;
  compact?: boolean;
}) {
  const { icon: WayIcon, color } = SCORE_WAYS[way];
  const icon = (
    <WayIcon size={12} color={`var(--mantine-color-${color}-5)`} className="shrink-0" aria-hidden />
  );
  const figure = (
    <Text
      fw={800}
      size="sm"
      c={value === undefined ? 'dimmed' : undefined}
      className="tabular-nums"
      lh={1.25}
    >
      {value === undefined ? '–' : abbreviateNumber(value)}
    </Text>
  );
  if (compact)
    return (
      <div
        className="flex min-w-0 items-center gap-1.5 rounded-md bg-gray-1 px-2 py-1 dark:bg-dark-5"
        title={way}
        data-way={way}
      >
        {icon}
        {figure}
        <span className="sr-only">{way}</span>
      </div>
    );
  return (
    <div
      className="flex min-w-0 flex-col rounded-md bg-gray-1 px-1.5 py-1 dark:bg-dark-5"
      data-way={way}
    >
      {figure}
      <span className="flex min-w-0 items-center gap-1">
        {icon}
        <Text size="xs" c="dimmed" truncate lh={1.2}>
          {way}
        </Text>
      </span>
    </div>
  );
}
