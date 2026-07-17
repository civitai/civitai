import type { BadgeProps } from '@mantine/core';
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
import { slugit } from '~/utils/string-helpers';
import { getMyChallengeBadge, getMyChallengeCta } from './myChallengeCard.utils';
import type { MyParticipatedChallengeItem } from '~/server/schema/challenge.schema';

const sharedBadgeProps: Omit<BadgeProps, 'children'> = {
  radius: 'xl',
  variant: 'filled',
  px: 8,
  h: 26,
  fw: 'bold',
};

// Semi-transparent black backing, matching ChallengeCard's "dark" chip pattern
// (StatusBadge fallback / days-left chip) — needed so the neutral "dark" swatch
// still reads over a bright entry image.
const darkBgStyle = { backgroundColor: 'rgba(0, 0, 0, 0.31)' } as const;

const badgeIcons = {
  trophy: IconTrophy,
  medal: IconMedal,
  hourglass: IconHourglass,
  check: IconCheck,
} as const;

// Reuse ChallengeCard's exact color tokens: yellow.7 (Complete), green (Live), blue (Upcoming).
const badgeColors = { gold: 'yellow.7', dark: 'dark', blue: 'blue', green: 'green' } as const;

export const MyChallengeCard = memo(function MyChallengeCard({
  data,
}: {
  data: MyParticipatedChallengeItem;
}) {
  const { id, title, theme, myEntryImage, myResult, myPlace, isLive, endsAt, nsfwLevel } = data;
  const badge = getMyChallengeBadge(myResult, myPlace);
  const cta = getMyChallengeCta(myResult, isLive);
  const BadgeIcon = badgeIcons[badge.icon];

  const image = myEntryImage
    ? {
        id: myEntryImage.id,
        url: myEntryImage.url,
        type: myEntryImage.type,
        width: myEntryImage.width ?? 512,
        height: myEntryImage.height ?? 512,
        nsfwLevel,
        hash: myEntryImage.hash,
        metadata: null,
      }
    : undefined;

  return (
    <AspectRatioImageCard
      href={`/challenges/${id}/${slugit(title)}`}
      alt={title}
      aspectRatio="square"
      image={image}
      header={
        <Badge
          className={cardClasses.chip}
          {...sharedBadgeProps}
          color={badgeColors[badge.color]}
          style={badge.color === 'dark' ? darkBgStyle : undefined}
        >
          <Group gap={4}>
            <BadgeIcon size={12} />
            <Text size="xs" fw="bold">
              {badge.label}
            </Text>
          </Group>
        </Badge>
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
          <Text size="xs" c="gray.3">
            {isLive ? (
              <>
                <DaysFromNow date={endsAt} withoutSuffix /> left · Live
              </>
            ) : (
              <>
                Ended <DaysFromNow date={endsAt} />
              </>
            )}
          </Text>
          {/* Non-interactive: AspectRatioImageCard already renders the whole card as a link
              to this same challenge, so a nested <button>/<a> here would be an a11y violation. */}
          <div
            className={clsx(
              'flex w-full items-center justify-center gap-1 rounded-md px-3 py-2 text-sm font-semibold',
              cta.filled === 'blue' ? 'bg-blue-6 text-white' : 'bg-white text-dark-9'
            )}
          >
            {cta.label}
            {cta.kind === 'add' ? <IconPlus size={15} /> : <IconArrowRight size={15} />}
          </div>
        </div>
      }
    />
  );
});
