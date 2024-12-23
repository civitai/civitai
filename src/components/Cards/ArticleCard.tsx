import { Badge, Text } from '@mantine/core';
import React from 'react';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { IconBolt, IconBookmark, IconEye, IconMessageCircle2 } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { slugit } from '~/utils/string-helpers';
import { formatDate } from '~/utils/date-helpers';
import type { ArticleGetAllRecord } from '~/server/services/article.service';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { AspectRatioImageCard } from '~/components/CardTemplates/AspectRatioImageCard';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';

export function ArticleCard({ data, aspectRatio }: Props) {
  const { classes, cx } = useCardStyles({ aspectRatio: 1 });
  const { id, title, coverImage, publishedAt, user, tags, stats } = data;
  const category = tags?.find((tag) => tag.isCategory);
  const { commentCount, viewCount, collectedCount, tippedAmountCount } = stats || {
    commentCount: 0,
    viewCount: 0,
    favoriteCount: 0,
    collectedCount: 0,
    likeCount: 0,
    tippedAmountCount: 0,
  };
  const tippedAmount = useBuzzTippingStore({ entityType: 'Article', entityId: data.id });

  return (
    <AspectRatioImageCard
      href={`/articles/${id}/${slugit(title)}`}
      aspectRatio={aspectRatio}
      contentType="article"
      contentId={id}
      image={coverImage}
      cosmetic={data.cosmetic?.data}
      header={
        <div className="flex w-full justify-between">
          {category && (
            <Badge
              size="sm"
              variant="gradient"
              gradient={{ from: 'cyan', to: 'blue' }}
              className={classes.chip}
            >
              {category.name}
            </Badge>
          )}
          <ArticleContextMenu article={data} />
        </div>
      }
      footer={
        <div className="flex w-full flex-col gap-2">
          <UserAvatarSimple {...user} />
          <div>
            {publishedAt && (
              <Text className={classes.dropShadow} size="xs" weight={500} color="white" inline>
                {formatDate(publishedAt)}
              </Text>
            )}
            {title && (
              <Text className={classes.dropShadow} size="xl" weight={700} lineClamp={2} lh={1.2}>
                {title}
              </Text>
            )}
          </div>
          <div className="flex items-center justify-between gap-1">
            <Badge className={cx(classes.statChip, classes.chip)} variant="light" radius="xl">
              <div className="flex items-center gap-0.5">
                <IconBookmark size={14} strokeWidth={2.5} />
                <Text size="xs">{abbreviateNumber(collectedCount)}</Text>
              </div>
              <div className="flex items-center gap-0.5">
                <IconMessageCircle2 size={14} strokeWidth={2.5} />
                <Text size="xs">{abbreviateNumber(commentCount)}</Text>
              </div>
              <InteractiveTipBuzzButton toUserId={user.id} entityType={'Article'} entityId={id}>
                <div className="flex items-center gap-0.5">
                  <IconBolt size={14} strokeWidth={2.5} />
                  <Text size="xs" tt="uppercase">
                    {abbreviateNumber(tippedAmountCount + tippedAmount)}
                  </Text>
                </div>
              </InteractiveTipBuzzButton>
            </Badge>
            <Badge className={cx(classes.statChip, classes.chip)} variant="light" radius="xl">
              <div className="flex items-center gap-0.5">
                <IconEye size={14} strokeWidth={2.5} />
                <Text size="xs">{abbreviateNumber(viewCount)}</Text>
              </div>
            </Badge>
          </div>
        </div>
      }
    />
  );
}

type Props = {
  data: ArticleGetAllRecord;
  aspectRatio?: 'landscape' | 'portrait' | 'square';
};
