import { Badge, Text } from '@mantine/core';
import { IconBook } from '@tabler/icons-react';
import clsx from 'clsx';
import cardClasses from '~/components/Cards/Cards.module.css';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import type { RouterOutput } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { formatGenreLabel } from '~/utils/comic-helpers';
import { slugit } from '~/utils/string-helpers';

type ComicItem = RouterOutput['comics']['getPublicProjects']['items'][number];

export function ComicCard({ data }: { data: ComicItem }) {
  const coverImage = data.coverImage
    ? {
        ...data.coverImage,
        type: data.coverImage.type ?? ('image' as const),
        metadata: (data.coverImage.metadata as MixedObject) ?? null,
      }
    : undefined;

  return (
    <AspectRatioImageCard
      href={`/comics/${data.id}/${slugit(data.name)}`}
      aspectRatio="portrait"
      image={coverImage}
      header={
        data.genre && (
          <Badge
            size="sm"
            variant="gradient"
            gradient={{ from: 'cyan', to: 'blue' }}
            className={cardClasses.chip}
          >
            {formatGenreLabel(data.genre)}
          </Badge>
        )
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
}
