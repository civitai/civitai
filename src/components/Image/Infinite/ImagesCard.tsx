import { ActionIcon, AspectRatio, createStyles } from '@mantine/core';
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
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { IconInfoCircle } from '@tabler/icons';
import { useRouter } from 'next/router';

export function ImagesCard({ data: image, height }: { data: ImagesInfiniteModel; height: number }) {
  const { classes } = useStyles();
  const filters = useImagesInfiniteContext();

  const tags = useMemo(() => {
    if (!image.tags) return undefined;
    return image.tags.filter((x) => x.type === 'Moderation');
  }, [image.tags]);

  const showVotes = tags && Array.isArray(tags) && !!tags.length;

  return (
    <InView rootMargin="600px">
      {({ inView, ref }) => (
        <MasonryCard withBorder shadow="sm" p={0} height={height} ref={ref}>
          {inView && (
            <>
              <ImageGuard
                images={[image]}
                render={(image) => (
                  <ImageGuard.Content>
                    {({ safe }) => (
                      <>
                        <ImageGuard.Report />
                        <ImageGuard.ToggleImage />
                        <RoutedContextLink modal="imageDetailModal" imageId={image.id} {...filters}>
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
                              style={{ width: '100%' }}
                            />
                          )}
                        </RoutedContextLink>
                        {showVotes ? (
                          <div className={classes.footer}>
                            <VotableTags entityType="image" entityId={image.id} tags={tags} />
                          </div>
                        ) : (
                          <>
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
                              withinPortal
                              className={classes.reactions}
                            />
                            {!image.hideMeta && image.meta && (
                              <ImageMetaPopover
                                meta={image.meta as any}
                                generationProcess={image.generationProcess ?? undefined}
                              >
                                <ActionIcon
                                  className={classes.info}
                                  variant="transparent"
                                  size="lg"
                                >
                                  <IconInfoCircle
                                    color="white"
                                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                                    opacity={0.8}
                                    strokeWidth={2.5}
                                    size={26}
                                  />
                                </ActionIcon>
                              </ImageMetaPopover>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </ImageGuard.Content>
                )}
              />
            </>
          )}
        </MasonryCard>
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  reactions: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    borderRadius: theme.radius.sm,
    background: theme.fn.rgba(
      theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
      0.8
    ),
    backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    padding: 4,
  },
  info: {
    position: 'absolute',
    bottom: 5,
    right: 5,
  },
}));
