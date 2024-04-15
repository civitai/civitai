import { Group, Stack, Text, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { PostsInfiniteModel } from '~/server/services/post.service';
import { useRouter } from 'next/router';
import { IconPhoto } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { truncate } from 'lodash-es';
import { constants } from '~/server/common/constants';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';

const IMAGE_CARD_WIDTH = 332;

export function PostCard({ data }: Props) {
  const { classes, cx } = useCardStyles({ aspectRatio: 1 });
  const router = useRouter();

  const image = data.images[0];

  return (
    <FeedCard href={`/posts/${data.id}`} aspectRatio="square" frameDecoration={data.cosmetic}>
      <div className={classes.root}>
        <ImageGuard2 image={image} connectType="post" connectId={data.id}>
          {(safe) => (
            <>
              <Group
                position="apart"
                align="start"
                spacing={4}
                className={cx(classes.contentOverlay, classes.top)}
                style={{ pointerEvents: 'none' }}
              >
                <ImageGuard2.BlurToggle sx={{ pointerEvents: 'auto' }} />
                <ImageContextMenu image={image} context="post" style={{ pointerEvents: 'auto' }} />
              </Group>
              {!safe ? (
                <MediaHash {...image} />
              ) : (
                <EdgeMedia
                  src={image.url}
                  name={image.name ?? image.id.toString()}
                  alt={
                    image.meta
                      ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                      : image.name ?? undefined
                  }
                  type={image.type}
                  width={IMAGE_CARD_WIDTH}
                  placeholder="empty"
                  className={classes.image}
                />
              )}
            </>
          )}
        </ImageGuard2>

        <Stack
          className={cx(classes.contentOverlay, classes.bottom, classes.gradientOverlay)}
          spacing="sm"
        >
          <Group position="apart" align="end" noWrap>
            <Stack spacing="sm">
              {data.user?.id !== -1 && (
                <UnstyledButton
                  sx={{ color: 'white' }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    router.push(`/user/${data.user.username}`);
                  }}
                >
                  <UserAvatar
                    user={data.user}
                    avatarProps={{ radius: 'md', size: 32 }}
                    withUsername
                  />
                </UnstyledButton>
              )}
              {data.title && (
                <Text size="xl" weight={700} lineClamp={2} lh={1.2}>
                  {data.title}
                </Text>
              )}
            </Stack>
            <Group align="end">
              <IconBadge className={classes.iconBadge} icon={<IconPhoto size={14} />}>
                <Text size="xs">{abbreviateNumber(data.imageCount)}</Text>
              </IconBadge>
            </Group>
          </Group>
        </Stack>
      </div>
    </FeedCard>
  );
}

type Props = { data: PostsInfiniteModel };
