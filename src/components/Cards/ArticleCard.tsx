import { Badge, Text } from '@mantine/core';
import React from 'react';
import cardClasses from '~/components/Cards/Cards.module.css';
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
import { MetricSubscriptionProvider, useLiveMetrics } from '~/components/Metrics';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import clsx from 'clsx';

export function ArticleCard({ data, aspectRatio }: Props) {
  return (
    <MetricSubscriptionProvider entityType="Article" entityId={data.id}>
      <ArticleCardContent data={data} aspectRatio={aspectRatio} />
    </MetricSubscriptionProvider>
  );
}

function ArticleCardContent({ data, aspectRatio }: Props) {
  const { id, title, coverImage, publishedAt, user, tags, stats } = data;
  const category = tags?.find((tag) => tag.isCategory);
  const tippedAmount = useBuzzTippingStore({ entityType: 'Article', entityId: data.id });

  // Live metrics for article stats
  const liveMetrics = useLiveMetrics('Article', data.id, {
    commentCount: stats?.commentCount ?? 0,
    viewCount: stats?.viewCount ?? 0,
    collectedCount: stats?.collectedCount ?? 0,
    tippedAmountCount: stats?.tippedAmountCount ?? 0,
  });

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
              className={cardClasses.chip}
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
              <Text className={cardClasses.dropShadow} size="xs" fw={500} inline>
                {formatDate(publishedAt)}
              </Text>
            )}
            {title && (
              <Text className={cardClasses.dropShadow} size="xl" fw={700} lineClamp={2} lh={1.2}>
                {title}
              </Text>
            )}
          </div>
          <div className="flex items-center justify-between gap-1">
            <Badge
              className={clsx(cardClasses.statChip, cardClasses.chip)}
              classNames={{ label: 'flex flex-nowrap gap-2' }}
              variant="light"
              radius="xl"
            >
              <div className="flex items-center gap-0.5">
                <IconBookmark size={14} strokeWidth={2.5} />
                <Text fw="bold" size="xs">
                  {abbreviateNumber(liveMetrics.collectedCount)}
                </Text>
              </div>
              <div className="flex items-center gap-0.5">
                <IconMessageCircle2 size={14} strokeWidth={2.5} />
                <Text fw="bold" size="xs">
                  {abbreviateNumber(liveMetrics.commentCount)}
                </Text>
              </div>
              <InteractiveTipBuzzButton toUserId={user.id} entityType={'Article'} entityId={id}>
                <div className="flex items-center gap-0.5">
                  <IconBolt size={14} strokeWidth={2.5} />
                  <Text fw="bold" size="xs" tt="uppercase">
                    {abbreviateNumber(liveMetrics.tippedAmountCount + tippedAmount)}
                  </Text>
                </div>
              </InteractiveTipBuzzButton>
            </Badge>
            <Badge
              className={clsx(cardClasses.statChip, cardClasses.chip)}
              variant="light"
              radius="xl"
            >
              <div className="flex items-center gap-0.5">
                <IconEye size={14} strokeWidth={2.5} />
                <Text fw="bold" size="xs">
                  {abbreviateNumber(liveMetrics.viewCount)}
                </Text>
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
