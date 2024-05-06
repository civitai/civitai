import { AspectRatio, createStyles } from '@mantine/core';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { PostsInfiniteModel } from '~/server/services/post.service';
import { PostReactions } from '~/components/Reaction/Reactions';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { useInView } from '~/hooks/useInView';
import { truncate } from 'lodash-es';
import { constants } from '~/server/common/constants';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { AddArtFrameMenuItem } from '~/components/Decorations/AddArtFrameMenuItem';
import { CosmeticEntity } from '@prisma/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useCardStyles } from '~/components/Cards/Cards.styles';

export function PostsCard({
  data: { images, id, stats, imageCount, cosmetic, user },
  height,
}: {
  data: PostsInfiniteModel;
  height?: number;
}) {
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView({ rootMargin: '600px' });
  const { classes } = useStyles();
  const { classes: sharedClasses } = useCardStyles({ aspectRatio: 1 });

  const image = images[0];
  const isOwner = currentUser?.id === user.id;

  return (
    <MasonryCard withBorder shadow="sm" p={0} height={height} ref={ref} frameDecoration={cosmetic}>
      {inView && (
        <>
          <ImageGuard2 image={image} connectType="post" connectId={id}>
            {(safe) => (
              <>
                {image.meta && 'civitaiResources' in (image.meta as object) && <OnsiteIndicator />}

                <ImageGuard2.BlurToggle className="absolute top-2 left-2 z-10" />
                {safe && (
                  <ImageContextMenu
                    image={image}
                    context="post"
                    className="absolute top-2 right-2 z-10"
                    additionalMenuItems={
                      isOwner ? (
                        <AddArtFrameMenuItem
                          entityType={CosmeticEntity.Post}
                          entityId={id}
                          image={image}
                          currentCosmetic={cosmetic}
                        />
                      ) : null
                    }
                  />
                )}

                <RoutedDialogLink
                  name="postDetail"
                  state={{ postId: id }}
                  className={cosmetic && safe ? sharedClasses.frameAdjustment : undefined}
                >
                  {!safe ? (
                    <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                      <MediaHash {...image} />
                    </AspectRatio>
                  ) : (
                    <EdgeMedia
                      src={image.url}
                      className={sharedClasses.image}
                      name={image.name ?? image.id.toString()}
                      alt={
                        image.meta
                          ? truncate(image.meta.prompt, {
                              length: constants.altTruncateLength,
                            })
                          : image.name ?? undefined
                      }
                      type={image.type}
                      width={450}
                      placeholder="empty"
                    />
                  )}
                </RoutedDialogLink>
                <PostReactions
                  className={classes.reactions}
                  imageCount={imageCount}
                  metrics={{
                    likeCount: stats?.likeCount,
                    dislikeCount: stats?.dislikeCount,
                    heartCount: stats?.heartCount,
                    laughCount: stats?.laughCount,
                    cryCount: stats?.cryCount,
                  }}
                />
              </>
            )}
          </ImageGuard2>
        </>
      )}
    </MasonryCard>
  );
}

const useStyles = createStyles((theme) => ({
  title: {
    lineHeight: 1.1,
    fontSize: 14,
    color: 'white',
    fontWeight: 500,
  },
  reactions: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    borderRadius: theme.radius.sm,
    background: theme.fn.rgba(
      theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[0],
      0.8
    ),
    // backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    padding: 4,
  },
}));
