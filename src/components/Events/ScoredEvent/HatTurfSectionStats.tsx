import { Text } from '@mantine/core';
import { IconRefresh, IconStack2, IconUsers } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import { formatMultiplier, formatRefillCadence } from '~/components/HatTurf/hat-turf.utils';

/** A multiplier this close to 1 is no catch-up at all. */
const NEUTRAL = 0.005;

/** What the viewer's team's catch-up means for their hats; nothing to say at 1x. */
export function catchUpNotice(multiplier: number | undefined) {
  if (multiplier === undefined || !Number.isFinite(multiplier)) return null;
  if (multiplier > 1 + NEUTRAL)
    return `Your team is behind: hats come ${formatMultiplier(
      multiplier
    )}× faster and you can hold more.`;
  if (multiplier < 1 - NEUTRAL)
    return `Your team leads: hats come slower (${formatMultiplier(multiplier)}×).`;
  return null;
}

/**
 * The three numbers that set the pace of Hat Turf for this viewer, under the pitch: how often a new
 * hat arrives, the most they can hold, and how many of the leading team's hats count on a picture.
 */
export function HatTurfSectionStats({
  perHour,
  cap,
  creditedPlayers,
  multiplier,
}: {
  perHour: number;
  cap: number;
  creditedPlayers: number;
  multiplier?: number;
}) {
  const cadence = formatRefillCadence(perHour);
  const stats: { key: string; icon: Icon; color: string; label: string; value: string }[] = [
    {
      key: 'refill',
      icon: IconRefresh,
      color: 'green',
      label: 'Hat refill',
      value: cadence ?? '–',
    },
    { key: 'cap', icon: IconStack2, color: 'blue', label: 'Hat cap', value: String(cap) },
    {
      key: 'scoring',
      icon: IconUsers,
      color: 'yellow',
      label: 'Scorers per image',
      value: String(creditedPlayers),
    },
  ];
  const notice = catchUpNotice(multiplier);
  return (
    <div
      className="relative z-[3] flex flex-col gap-2 px-5 pb-4 @sm:px-7 @sm:col-span-full"
      data-testid="hat-turf-section-stats"
    >
      <div className="grid grid-cols-3 gap-2 @sm:max-w-[420px]">
        {stats.map(({ key, icon: StatIcon, color, label, value }) => (
          <div
            key={key}
            className="flex min-w-0 flex-col items-center rounded-md border border-solid border-white/10 bg-white/5 px-1.5 py-2 backdrop-blur-sm"
            data-testid={`hat-turf-stat-${key}`}
          >
            <StatIcon
              size={14}
              color={`var(--mantine-color-${color}-4)`}
              className="shrink-0"
              aria-hidden
            />
            <Text
              fw={800}
              size="md"
              lh={1.15}
              c="white"
              className="mt-1 max-w-full text-center tabular-nums"
            >
              {value}
            </Text>
            <Text size="xs" c="gray.5" lh={1.2} className="max-w-full text-center">
              {label}
            </Text>
          </div>
        ))}
      </div>
      {notice && (
        <Text size="xs" c="gray.3" data-testid="hat-turf-catch-up">
          {notice}
        </Text>
      )}
    </div>
  );
}
