import { AspectRatio, createStyles } from '@mantine/core';
import { useMemo } from 'react';
import { InView } from 'react-intersection-observer';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Reactions } from '~/components/Reaction/Reactions';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { useImagesInfiniteContext } from '~/components/Image/Infinite/ImagesInfinite';

export function ImagesCard({
  data: image,
  width: cardWidth,
}: {
  data: ImagesInfiniteModel;
  width: number;
}) {
  const { classes } = useStyles();
  const { modelId, postId, username } = useImagesInfiniteContext();

  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = cardWidth > 0 ? cardWidth : 300;
    const aspectRatio = image.width / image.height;
    const imageHeight = Math.floor(width / aspectRatio) + (aspectRatio >= 1 ? 60 : 0);
    return Math.min(imageHeight, 600);
  }, [cardWidth, image.width, image.height]);

  return (
    <InView>
      {({ inView, ref }) => (
        <RoutedContextLink
          modal="imageDetailModal"
          imageId={image.id}
          modelId={modelId}
          postId={postId}
          username={username}
        >
          <MasonryCard withBorder shadow="sm" p={0} height={height} ref={ref}>
            {inView && (
              <>
                <ImageGuard
                  images={[image]}
                  render={(image) => (
                    <ImageGuard.Content>
                      {({ safe }) => (
                        <>
                          <ImageGuard.ToggleImage
                            sx={(theme) => ({
                              backgroundColor: theme.fn.rgba(theme.colors.red[9], 0.4),
                              color: 'white',
                              backdropFilter: 'blur(7px)',
                              boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                            })}
                          />
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
                              style={{ width: '100%', zIndex: 2, position: 'relative' }}
                            />
                          )}
                          <div className={classes.footer}>
                            <Reactions
                              entityId={image.id}
                              entityType="image"
                              reactions={image.reactions}
                              metrics={{
                                likeCount: image.stats?.likeCountAllTime,
                                dislikeCount: image.stats?.dislikeCountAllTime,
                                heartCount: image.stats?.heartCountAllTime,
                                laughCount: image.stats?.laughCountAllTime,
                                cryCount: image.stats?.cryCountAllTime,
                              }}
                              readonly={!safe}
                            />
                          </div>
                        </>
                      )}
                    </ImageGuard.Content>
                  )}
                />
              </>
            )}
          </MasonryCard>
        </RoutedContextLink>
      )}
    </InView>
  );
}

const useStyles = createStyles((theme) => ({
  title: {
    lineHeight: 1.1,
    fontSize: 14,
    color: 'white',
    fontWeight: 500,
  },
  footer: {
    display: 'flex',
    flexDirection: 'column',
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    background: theme.fn.gradient({
      from: 'rgba(37,38,43,0.8)',
      to: 'rgba(37,38,43,0)',
      deg: 0,
    }),
    backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    zIndex: 10,
    gap: 6,
    padding: theme.spacing.xs,
  },
}));
