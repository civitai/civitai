import { AspectRatio, LoadingOverlay, createStyles, Text } from '@mantine/core';
import Link from 'next/link';
import { useMemo } from 'react';
import { InView } from 'react-intersection-observer';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { PostsInfiniteModel } from '~/server/services/post.service';
import { useState } from 'react';
import { Reactions } from '~/components/Reaction/Reactions';

export function PostsCard({
  data: { image, id, title },
  width: cardWidth,
}: {
  data: PostsInfiniteModel;
  width: number;
}) {
  const { classes } = useStyles();
  const [loading, setLoading] = useState(false);

  const height = useMemo(() => {
    if (!image.width || !image.height) return 300;
    const width = cardWidth > 0 ? cardWidth : 300;
    const aspectRatio = image.width / image.height;
    // const imageHeight = Math.floor(width / aspectRatio) + (aspectRatio >= 1 ? 60 : 0);
    const imageHeight = Math.floor(width / aspectRatio);
    return Math.min(imageHeight, 600);
  }, [cardWidth, image.width, image.height]);

  return (
    <InView>
      {({ inView, ref }) => (
        <Link href={`/posts/${id}`} passHref>
          <MasonryCard
            withBorder
            shadow="sm"
            p={0}
            height={height}
            ref={ref}
            component="a"
            onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
              if (!(e.ctrlKey || e.metaKey) && e.button !== 1) setLoading(true);
            }}
          >
            {inView && (
              <>
                <LoadingOverlay visible={loading} zIndex={9} loaderProps={{ variant: 'dots' }} />
                <ImageGuard
                  images={[image]}
                  connect={{ entityId: id, entityType: 'post' }}
                  render={(image) => (
                    <ImageGuard.Content>
                      {({ safe }) => (
                        <>
                          <ImageGuard.ToggleConnect
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
                            {title && (
                              <Text className={classes.title} lineClamp={2}>
                                {title}
                              </Text>
                            )}
                            <Reactions
                              entityId={image.id}
                              entityType="image"
                              reactions={image.reactions}
                              metrics={{
                                likeCount: image.likeCount,
                                dislikeCount: image.dislikeCount,
                                heartCount: image.heartCount,
                                laughCount: image.laughCount,
                                cryCount: image.cryCount,
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
        </Link>
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
