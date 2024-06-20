import { Badge, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useRouter } from 'next/router';
import { IconBolt, IconBookmark, IconEye, IconMessageCircle2 } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { slugit } from '~/utils/string-helpers';
import { formatDate } from '~/utils/date-helpers';
import type { ArticleGetAllRecord } from '~/server/services/article.service';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { HolidayFrame } from '../Decorations/HolidayFrame';
import { CosmeticType } from '@prisma/client';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';

const IMAGE_CARD_WIDTH = 450;

export function ArticleCard({ data, aspectRatio }: Props) {
  const { classes, cx } = useCardStyles({ aspectRatio: 1 });
  const router = useRouter();
  const { id, title, coverImage, publishedAt, user, tags, stats } = data;
  const category = tags?.find((tag) => tag.isCategory);
  const { commentCount, viewCount, favoriteCount, collectedCount, tippedAmountCount } = stats || {
    commentCount: 0,
    viewCount: 0,
    favoriteCount: 0,
    collectedCount: 0,
    likeCount: 0,
    tippedAmountCount: 0,
  };
  const tippedAmount = useBuzzTippingStore({ entityType: 'Article', entityId: data.id });

  const cardDecoration = data.user.cosmetics?.find(
    ({ cosmetic }) => cosmetic.type === CosmeticType.ContentDecoration
  ) as (typeof data.user.cosmetics)[number] & {
    data?: { lights?: number; upgradedLights?: number };
  };

  return (
    <HolidayFrame {...cardDecoration}>
      <FeedCard
        href={`/articles/${id}/${slugit(title)}`}
        aspectRatio={aspectRatio}
        className={classes.link}
        frameDecoration={data.cosmetic}
      >
        <div className={classes.root}>
          {coverImage && (
            <ImageGuard2 image={coverImage}>
              {(safe) => (
                <div
                  className={cx(
                    'relative flex-1 h-full',
                    data.cosmetic && safe && classes.frameAdjustment
                  )}
                >
                  <Group
                    spacing={4}
                    position="apart"
                    align="top"
                    className="absolute inset-x-2 top-2 z-10"
                  >
                    <Group spacing={4}>
                      <ImageGuard2.BlurToggle />
                      {category && (
                        <Badge size="sm" variant="gradient" gradient={{ from: 'cyan', to: 'blue' }}>
                          {category.name}
                        </Badge>
                      )}
                    </Group>
                    <ArticleContextMenu article={data} />
                  </Group>
                  {!safe ? (
                    <MediaHash {...coverImage} />
                  ) : (
                    <EdgeMedia
                      className={cx(classes.image)}
                      src={coverImage.url}
                      width={IMAGE_CARD_WIDTH * 2.5}
                      loading="lazy"
                    />
                  )}
                </div>
              )}
            </ImageGuard2>
          )}

          <Stack className={cx('footer', classes.contentOverlay, classes.bottom)} spacing="sm">
            {user?.id !== -1 && (
              <UnstyledButton
                sx={{ color: 'white' }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  router.push(`/user/${user.username}`);
                }}
              >
                <UserAvatar user={user} avatarProps={{ radius: 'xl', size: 32 }} withUsername />
              </UnstyledButton>
            )}
            <Stack spacing={0}>
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
            </Stack>
            <Group align="center" position="apart" spacing={4}>
              <Badge className={cx(classes.statChip, classes.chip)} variant="light" radius="xl">
                <Group spacing={2}>
                  <IconBookmark size={14} strokeWidth={2.5} />
                  <Text size="xs">{abbreviateNumber(collectedCount)}</Text>
                </Group>
                <Group spacing={2}>
                  <IconMessageCircle2 size={14} strokeWidth={2.5} />
                  <Text size="xs">{abbreviateNumber(commentCount)}</Text>
                </Group>
                <InteractiveTipBuzzButton toUserId={user.id} entityType={'Article'} entityId={id}>
                  <Group spacing={2}>
                    <IconBolt size={14} strokeWidth={2.5} />
                    <Text size="xs" tt="uppercase">
                      {abbreviateNumber(tippedAmountCount + tippedAmount)}
                    </Text>
                  </Group>
                </InteractiveTipBuzzButton>
              </Badge>
              <Badge className={cx(classes.statChip, classes.chip)} variant="light" radius="xl">
                <Group spacing={2}>
                  <IconEye size={14} strokeWidth={2.5} />
                  <Text size="xs">{abbreviateNumber(viewCount)}</Text>
                </Group>
              </Badge>
            </Group>
          </Stack>
        </div>
      </FeedCard>
    </HolidayFrame>
  );
}

type Props = {
  data: ArticleGetAllRecord;
  aspectRatio?: 'flat' | 'landscape' | 'portrait' | 'square';
};
