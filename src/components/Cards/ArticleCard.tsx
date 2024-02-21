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
import type { ArticleGetAll } from '~/server/services/article.service';
import { ArticleContextMenu } from '~/components/Article/ArticleContextMenu';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { HolidayFrame } from '../Decorations/HolidayFrame';
import { CosmeticType } from '@prisma/client';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';

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
        // useCSSAspectRatio={useCSSAspectRatio}
        className={classes.link}
      >
        <div className={classes.root}>
          {coverImage && (
            <ImageGuard
              connect={{ entityId: id, entityType: 'article' }}
              images={[coverImage]}
              render={(image) => (
                <>
                  <Group
                    spacing={4}
                    position="apart"
                    align="top"
                    className={cx(classes.contentOverlay, classes.top)}
                    noWrap
                  >
                    <ImageGuard.ToggleConnect position="static" />
                    {category && (
                      <Badge color="dark" size="sm" variant="light" radius="xl">
                        <Text color="white">{category.name}</Text>
                      </Badge>
                    )}

                    <Stack ml="auto">
                      <ArticleContextMenu article={data} />
                    </Stack>
                  </Group>
                  <ImageGuard.Content>
                    {({ safe }) =>
                      !safe ? (
                        <MediaHash {...image} />
                      ) : (
                        <EdgeMedia
                          src={image.url}
                          // TODO: hardcoding upscaling because cover images look awful with the new card since we don't store width/height
                          width={IMAGE_CARD_WIDTH * 2.5}
                          placeholder="empty"
                          className={classes.image}
                          loading="lazy"
                        />
                      )
                    }
                  </ImageGuard.Content>
                </>
              )}
            />
          )}

          <Stack
            className={cx('footer', classes.contentOverlay, classes.bottom, classes.fullOverlay)}
            spacing="sm"
          >
            {user?.id !== -1 && (
              <UnstyledButton
                sx={{ color: 'white' }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  router.push(`/user/${user.username}`);
                }}
              >
                <UserAvatar user={user} avatarProps={{ radius: 'md', size: 32 }} withUsername />
              </UnstyledButton>
            )}
            <Stack spacing={0}>
              {publishedAt && (
                <Text size="xs" weight={500} color="white" inline>
                  {formatDate(publishedAt)}
                </Text>
              )}
              {title && (
                <Text size="xl" weight={700} lineClamp={2} lh={1.2}>
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
  data: ArticleGetAll[0];
  aspectRatio?: 'flat' | 'landscape' | 'portrait' | 'square';
};
