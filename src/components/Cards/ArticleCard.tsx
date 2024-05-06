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
  const { commentCount, viewCount, favoriteCount, tippedAmountCount } = stats || {
    commentCount: 0,
    viewCount: 0,
    favoriteCount: 0,
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
                    className="absolute top-2 left-2 right-2 z-10"
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
            <Group position="apart">
              <Group spacing={4}>
                <IconBadge icon={<IconBookmark size={14} />} color="dark">
                  <Text size="xs" color="white">
                    {abbreviateNumber(favoriteCount)}
                  </Text>
                </IconBadge>
                <IconBadge icon={<IconMessageCircle2 size={14} />} color="dark">
                  <Text size="xs" color="white">
                    {abbreviateNumber(commentCount)}
                  </Text>
                </IconBadge>
                <InteractiveTipBuzzButton toUserId={user.id} entityType={'Article'} entityId={id}>
                  <IconBadge icon={<IconBolt size={14} />} color="dark">
                    <Text size="xs" color="white">
                      {abbreviateNumber(tippedAmountCount + tippedAmount)}
                    </Text>
                  </IconBadge>
                </InteractiveTipBuzzButton>
              </Group>
              <IconBadge icon={<IconEye size={14} />} color="dark">
                <Text size="xs" color="white">
                  {abbreviateNumber(viewCount)}
                </Text>
              </IconBadge>
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
