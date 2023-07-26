import { Group, Stack, Text, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { PostsInfiniteModel } from '~/server/services/post.service';
import { useRouter } from 'next/router';
import { IconPhoto } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { IconBadge } from '~/components/IconBadge/IconBadge';

const IMAGE_CARD_WIDTH = 332;

export function PostCard({ data }: Props) {
  const { classes, cx } = useCardStyles({ aspectRatio: 1 });
  const router = useRouter();
  return (
    <FeedCard href={`/posts/${data.id}`} aspectRatio="square">
      <div className={classes.root}>
        {data.image && (
          <ImageGuard
            images={[data.image]}
            connect={{ entityId: data.id, entityType: 'post' }}
            render={(image) => (
              <ImageGuard.Content>
                {({ safe }) => (
                  <>
                    <ImageGuard.Report context="post" />
                    <ImageGuard.ToggleConnect position="top-left" />
                    {!safe ? (
                      <MediaHash {...data.image} />
                    ) : (
                      <EdgeImage
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? undefined}
                        width={IMAGE_CARD_WIDTH}
                        placeholder="empty"
                        className={classes.image}
                      />
                    )}
                  </>
                )}
              </ImageGuard.Content>
            )}
          />
        )}
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

                    router.push(`/users/${data.user.username}/posts`);
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
