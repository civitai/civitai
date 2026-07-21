import { Text, Title } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { ChallengeEventListItem } from '~/server/schema/challenge.schema';
import { formatDate } from '~/utils/date-helpers';

// Dark gradient-stop tints per `titleColor`. Hardcoded hex (Tailwind's stock `900` shade for
// each name) rather than `from-{color}-900` utility classes: this project's tailwind.config.js
// overrides blue/red/orange/yellow/green with Mantine's 0-9 shade scale, so a `-900` suffix on
// those colors doesn't exist and would silently emit no background. Arbitrary-value classes
// (`from-[#hex]`) sidestep the theme override entirely.
const gradientByTitleColor: Record<string, string> = {
  blue: 'from-[#1e3a8a]/80',
  purple: 'from-[#581c87]/80',
  red: 'from-[#7f1d1d]/80',
  orange: 'from-[#7c2d12]/80',
  yellow: 'from-[#713f12]/80',
  green: 'from-[#14532d]/80',
  pink: 'from-[#831843]/80',
};
const DEFAULT_GRADIENT = 'from-dark-9/80';

export function EventBannerCard({ event }: { event: ChallengeEventListItem }) {
  const gradient =
    (event.titleColor && gradientByTitleColor[event.titleColor]) ?? DEFAULT_GRADIENT;
  const count = event.challenges.length;

  return (
    <Link
      href={`/challenges/events/${event.id}`}
      className="relative flex h-40 w-full overflow-hidden rounded-lg no-underline sm:h-48"
    >
      {event.coverImage && (
        <EdgeMedia
          src={event.coverImage.url}
          type={event.coverImage.type}
          width={1600}
          className="absolute inset-0 size-full object-cover"
          alt={event.title}
        />
      )}
      <div className={clsx('absolute inset-0 bg-gradient-to-r to-transparent', gradient)} />
      <div className="relative z-10 flex flex-col justify-end gap-1 p-5">
        <Text size="xs" c="white" className="opacity-80">
          {formatDate(event.startDate)} – {formatDate(event.endDate)} · {count}{' '}
          {count === 1 ? 'challenge' : 'challenges'}
        </Text>
        <Title order={2} c="white" className="drop-shadow">
          {event.title}
        </Title>
        <Text size="sm" c="white" className="flex items-center gap-1 opacity-90">
          Explore Event <IconArrowRight size={16} />
        </Text>
      </div>
    </Link>
  );
}
