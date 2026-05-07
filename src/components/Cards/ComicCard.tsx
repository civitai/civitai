import { Badge, Text } from '@mantine/core';
import { memo } from 'react';
import { IconBook } from '@tabler/icons-react';
import clsx from 'clsx';
import cardClasses from '~/components/Cards/Cards.module.css';
import { ComicCardContextMenu } from '~/components/Cards/ComicCardContextMenu';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import type { RouterOutput } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { formatGenreLabel } from '~/utils/comic-helpers';
import { slugit } from '~/utils/string-helpers';
import { getHighestBrowsingLevelBit } from '~/shared/constants/browsingLevel.constants';

type ComicItem = RouterOutput['comics']['getPublicProjects']['items'][number];

export const ComicCard = memo(function ComicCard({ data }: { data: ComicItem }) {
  const coverImage = data.coverImage
    ? {
        ...data.coverImage,
        type: data.coverImage.type ?? ('image' as const),
        metadata: (data.coverImage.metadata as MixedObject) ?? null,
        // A comic cover may be PG while chapters are mature (or vice versa),
        // so we want the card to gate by the worst content reachable by
        // clicking through. We can't pass the bit_or composite directly:
        // ImageGuard2 blurs via `Flags.hasFlag(blurLevels, nsfwLevel)`,
        // which requires every bit of `nsfwLevel` to be present in
        // `blurLevels` — so PG | R = 5 fails the check (PG isn't a blur
        // level) and the card never blurs. Reduce to the highest single
        // bit instead: that's both a valid label key and a value the blur
        // gate accepts as expected.
        nsfwLevel: getHighestBrowsingLevelBit(
          (data.coverImage.nsfwLevel ?? 0) | (data.nsfwLevel ?? 0)
        ),
      }
    : undefined;

  return (
    <AspectRatioImageCard
      href={`/comics/${data.id}/${slugit(data.name)}`}
      aspectRatio="portrait"
      image={coverImage}
      header={
        <div className="flex w-full items-start justify-between">
          <div>
            {data.genre && (
              <Badge
                size="sm"
                variant="gradient"
                gradient={{ from: 'cyan', to: 'blue' }}
                className={cardClasses.chip}
              >
                {formatGenreLabel(data.genre)}
              </Badge>
            )}
          </div>
          <ComicCardContextMenu comic={{ id: data.id, user: data.user }} />
        </div>
      }
      footer={
        <div className="flex w-full flex-col gap-2">
          <UserAvatarSimple {...data.user} />
          <Text className={cardClasses.dropShadow} size="xl" fw={700} lineClamp={2} lh={1.2}>
            {data.name}
          </Text>
          <Badge
            className={clsx(cardClasses.statChip, cardClasses.chip)}
            variant="light"
            radius="xl"
          >
            <div className="flex items-center gap-0.5">
              <IconBook size={14} strokeWidth={2.5} />
              <Text fw="bold" size="xs">
                {abbreviateNumber(data.chapterCount)} ch.
              </Text>
            </div>
          </Badge>
        </div>
      }
      footerGradient
    />
  );
});
