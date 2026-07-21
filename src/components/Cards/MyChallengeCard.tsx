import { Badge, Group, Text } from '@mantine/core';
import { memo } from 'react';
import {
  IconTrophy,
  IconMedal,
  IconHourglass,
  IconCheck,
  IconArrowRight,
  IconPlus,
} from '@tabler/icons-react';
import clsx from 'clsx';
import cardClasses from '~/components/Cards/Cards.module.css';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { NextLink } from '~/components/NextLink/NextLink';
import { slugit } from '~/utils/string-helpers';
import { getMyChallengeBadge, getMyChallengeCta } from './myChallengeCard.utils';
import type { MyParticipatedChallengeItem } from '~/server/schema/challenge.schema';

const badgeIcons = {
  trophy: IconTrophy,
  medal: IconMedal,
  hourglass: IconHourglass,
  check: IconCheck,
} as const;

// Per-result badge palette (matches designs/challenges-feed.pen v4). Gold uses dark content for
// contrast; the rest use white.
const badgeStyles = {
  gold: { bg: 'var(--mantine-color-yellow-5)', fg: '#1a1b1e' },
  dark: { bg: 'var(--mantine-color-gray-8)', fg: '#ffffff' },
  blue: { bg: 'var(--mantine-color-blue-6)', fg: '#ffffff' },
  green: { bg: 'var(--mantine-color-green-8)', fg: '#ffffff' },
} as const;

export const MyChallengeCard = memo(function MyChallengeCard({
  data,
}: {
  data: MyParticipatedChallengeItem;
}) {
  const { id, title, theme, myEntryImage, myResult, myPlace, isLive, endsAt } = data;
  const badge = getMyChallengeBadge(myResult, myPlace);
  const cta = getMyChallengeCta(myResult, isLive);
  const BadgeIcon = badgeIcons[badge.icon];
  const badgeStyle = badgeStyles[badge.color];
  const challengeHref = `/challenges/${id}/${slugit(title)}`;
  // "View entry" goes straight to the user's own image; everything else (results, and the
  // submit flow "Add another entry" opens from) lives on the challenge page.
  const ctaHref =
    cta.kind === 'entry' && myEntryImage ? `/images/${myEntryImage.id}` : challengeHref;

  const image = myEntryImage
    ? {
        id: myEntryImage.id,
        url: myEntryImage.url,
        type: myEntryImage.type,
        width: myEntryImage.width ?? 512,
        height: myEntryImage.height ?? 512,
        nsfwLevel: myEntryImage.nsfwLevel,
        hash: myEntryImage.hash,
        metadata: null,
      }
    : undefined;

  return (
    <AspectRatioImageCard
      href={challengeHref}
      alt={title}
      aspectRatio="square"
      image={image}
      header={
        <div className="flex w-full items-start justify-between gap-2">
          <Badge
            className={cardClasses.chip}
            radius="xl"
            variant="filled"
            tt="none"
            px={10}
            h={26}
            style={{ backgroundColor: badgeStyle.bg }}
          >
            <Group gap={5}>
              <BadgeIcon size={13} color={badgeStyle.fg} />
              <Text size="xs" fw={800} style={{ color: badgeStyle.fg }}>
                {badge.label}
              </Text>
            </Group>
          </Badge>
          <div
            className={clsx('shrink-0 rounded-full px-2.5 py-1', cardClasses.chip)}
            style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          >
            <Text size="xs" fw={600} c="gray.2">
              {isLive ? (
                <>
                  <DaysFromNow date={endsAt} withoutSuffix /> left · Live
                </>
              ) : myResult === 'judging' ? (
                // No judging deadline is exposed, and "Ended 3h ago" next to a Judging badge
                // reads as a contradiction, so state the phase instead of a date.
                'Judging'
              ) : (
                <>
                  Ended <DaysFromNow date={endsAt} />
                </>
              )}
            </Text>
          </div>
        </div>
      }
      footerGradient
      footer={
        <div className="flex w-full flex-col gap-2">
          {theme && (
            <Text
              size="sm"
              c="white"
              lineClamp={1}
              style={{ textShadow: '0 1px 1px rgb(0 0 0 / 0.05)' }}
            >
              Theme: {theme}
            </Text>
          )}
          <Text size="xl" fw={700} lineClamp={2} lh={1.2} c="white">
            {title}
          </Text>
          {/* A real link, not a nested one: AspectRatioImageCard's card link only wraps the
              image — header/footer are siblings of it. `pointer-events-auto` opts back in from
              the footer overlay's `pointer-events: none`. */}
          <NextLink
            href={ctaHref}
            className={clsx(
              'pointer-events-auto flex w-full items-center justify-center gap-1 rounded-md px-3 py-2 text-sm font-semibold no-underline',
              cta.filled === 'blue' ? 'bg-blue-6 text-white' : 'bg-white text-dark-9'
            )}
          >
            {cta.label}
            {cta.kind === 'add' ? <IconPlus size={15} /> : <IconArrowRight size={15} />}
          </NextLink>
        </div>
      }
    />
  );
});
