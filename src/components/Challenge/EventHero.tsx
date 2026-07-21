import { Text, Title } from '@mantine/core';
import { IconArrowLeft } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { ChallengeEventListItem } from '~/server/schema/challenge.schema';
import { daysFromNow, formatDate } from '~/utils/date-helpers';

// Hardcoded hex (Tailwind's stock `900` shade) — this project's tailwind.config.js remaps
// blue/red/orange/yellow/green to Mantine's 0-9 scale, so `-900` utility classes don't exist.
// Matches EventBannerCard's approach.
const gradientByTitleColor: Record<string, string> = {
  blue: 'from-[#1e3a8a]',
  purple: 'from-[#581c87]',
  red: 'from-[#7f1d1d]',
  orange: 'from-[#7c2d12]',
  yellow: 'from-[#713f12]',
  green: 'from-[#14532d]',
  pink: 'from-[#831843]',
};
const DEFAULT_GRADIENT = 'from-dark-9';

type EventHeroData = ChallengeEventListItem & { challengeCount: number; active: boolean };

export function EventHero({ event }: { event: EventHeroData }) {
  const gradient =
    (event.titleColor && gradientByTitleColor[event.titleColor]) ?? DEFAULT_GRADIENT;
  const isActive = event.active && new Date(event.endDate) >= new Date();
  const count = event.challengeCount;

  return (
    <div className="relative flex min-h-[220px] w-full flex-col justify-between overflow-hidden rounded-lg p-5 sm:min-h-[280px] sm:p-8">
      {event.coverImage && (
        <EdgeMedia
          src={event.coverImage.url}
          type={event.coverImage.type}
          width={1600}
          className="absolute inset-0 size-full object-cover"
          alt=""
        />
      )}
      <div className={clsx('absolute inset-0 bg-gradient-to-br to-black/60', gradient)} />
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />

      <Link
        href="/challenges"
        className="relative z-10 flex w-fit items-center gap-1 text-sm font-semibold text-white/90 no-underline hover:text-white"
      >
        <IconArrowLeft size={16} /> All Challenges
      </Link>

      <div className="relative z-10 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={clsx(
                'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
                isActive ? 'bg-[#40c057]/20 text-[#69db7c]' : 'bg-white/10 text-white/70'
              )}
            >
              <span
                className={clsx('size-2 rounded-full', isActive ? 'bg-[#40c057]' : 'bg-white/40')}
              />
              {isActive ? 'Active Event' : 'Event Ended'}
            </span>
            <Text size="sm" c="white" className="opacity-80">
              {isActive ? `Ends ${daysFromNow(event.endDate)}` : `Ended ${daysFromNow(event.endDate)}`}
            </Text>
          </div>
          <Title order={1} c="white" className="text-2xl drop-shadow sm:text-4xl">
            {event.title}
          </Title>
          <Text c="white" className="opacity-80">
            {formatDate(event.startDate)} – {formatDate(event.endDate)}
          </Text>
          {event.description && (
            <Text c="white" className="max-w-2xl opacity-75" lineClamp={2}>
              {event.description}
            </Text>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-start sm:items-end">
          <Text className="text-4xl font-extrabold text-white drop-shadow">{count}</Text>
          <Text size="sm" c="white" className="opacity-70">
            {count === 1 ? 'Challenge' : 'Challenges'}
          </Text>
        </div>
      </div>
    </div>
  );
}
