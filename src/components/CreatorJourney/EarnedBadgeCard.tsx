import { Text } from '@mantine/core';
import type { ReactNode } from 'react';
import { IconCalendarCheck, IconTrendingUp } from '@tabler/icons-react';
import { earnedLabel } from '~/components/CreatorJourney/CreatorAchievements';
import {
  accentVar,
  DEFAULT_ACCENT,
  TierBadge,
  tierAccents,
} from '~/components/CreatorJourney/tier-badge';
import {
  SpotlightBorderCard,
  SpotlightDivider,
} from '~/components/SpotlightCard/SpotlightBorderCard';
import { numberWithCommas } from '~/utils/number-helpers';

export type EarnedBadge = {
  key: string;
  name: string;
  badgeUrl: string | null;
  track: string;
  threshold?: number | null;
  description: string | null;
  achievedAt: Date | null;
};

/** An earned badge on a spotlight card: on the journey page shelf and the profile's achievements. */
export function EarnedBadgeCard({
  badge,
  accent,
  action,
}: {
  badge: EarnedBadge;
  accent?: string;
  action?: ReactNode;
}) {
  accent ??= tierAccents[badge.key] ?? DEFAULT_ACCENT;

  return (
    <SpotlightBorderCard
      color={accent}
      style={accentVar(accent)}
      faceClassName="flex flex-col items-center gap-2 p-4 text-center"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24 opacity-20"
        style={{
          background: 'radial-gradient(60% 100% at 50% 0%, var(--cj-accent) 0%, transparent 100%)',
        }}
      />
      {action && <div className="absolute right-2 top-2">{action}</div>}
      <TierBadge name={badge.name} badgeUrl={badge.badgeUrl} state="earned" size={96} />
      <Text fw={800} size="lg" lh={1.2}>
        {badge.name}
      </Text>
      {badge.track === 'score' && badge.threshold != null ? (
        <div className="flex flex-col items-center">
          <div className="flex items-center gap-1">
            <IconTrendingUp size={16} className="shrink-0 text-[var(--cj-accent)]" />
            <Text fw={700} className="tabular-nums">
              {numberWithCommas(badge.threshold)}
            </Text>
          </div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} className="tracking-wide">
            Creator Score
          </Text>
        </div>
      ) : (
        badge.description && (
          <Text size="xs" c="dimmed">
            {badge.description}
          </Text>
        )
      )}
      <div className="mt-auto flex w-full flex-col items-center gap-2">
        <SpotlightDivider />
        <div className="flex items-center gap-1.5">
          <IconCalendarCheck size={14} className="shrink-0 text-gray-6 dark:text-dark-2" />
          <Text size="xs" c="dimmed">
            {earnedLabel(badge.achievedAt)}
          </Text>
        </div>
      </div>
    </SpotlightBorderCard>
  );
}
