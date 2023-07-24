import { AspectRatio, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import React from 'react';
import { FeedCard } from '~/components/Cards/FeedCard';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { PostsInfiniteModel } from '~/server/services/post.service';
import { useRouter } from 'next/router';
import { IconPhoto } from '@tabler/icons-react';
import { abbreviateNumber } from '~/utils/number-helpers';
import { IconBadge } from '~/components/IconBadge/IconBadge';

export function PostCard({ data }: Props) {
  const { classes, cx } = useCardStyles();
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
                    <RoutedContextLink modal="postDetailModal" postId={data.id}>
                      {!safe ? (
                        <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                          <MediaHash {...image} />
                        </AspectRatio>
                      ) : (
                        <EdgeImage
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          width={450}
                          placeholder="empty"
                          style={{ width: '100%', position: 'relative' }}
                        />
                      )}
                    </RoutedContextLink>
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
          {data.user?.id !== -1 && (
            <UnstyledButton
              sx={{ color: 'white' }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();

                router.push(`/users/${data.user.username}`);
              }}
            >
              <UserAvatar user={data.user} avatarProps={{ radius: 'md', size: 32 }} withUsername />
            </UnstyledButton>
          )}
          <Group position="apart" noWrap>
            <Text size="xl" weight={700} lineClamp={2} inline>
              {data.title}
            </Text>
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
