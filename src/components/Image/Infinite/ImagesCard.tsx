import {
  ActionIcon,
  Alert,
  AspectRatio,
  Badge,
  Box,
  Group,
  Loader,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { ImageIngestionStatus } from '@prisma/client';
import { IconInfoCircle } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { InView } from 'react-intersection-observer';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImagesInfiniteContext } from '~/components/Image/Infinite/ImagesInfinite';
import { useImageIngestionContext } from '~/components/Image/Ingestion/ImageIngestionProvider';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Reactions } from '~/components/Reaction/Reactions';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { ImagesInfiniteModel } from '~/server/services/image.service';

export function ImagesCard({ data: image, height }: { data: ImagesInfiniteModel; height: number }) {
  const { classes, cx } = useStyles();
  const filters = useImagesInfiniteContext();

  const ingestionData = useImageIngestionContext(
    useCallback(
      (state) => state.images[image.id] ?? { ingestion: ImageIngestionStatus.Scanned },
      [image.id]
    )
  );
  const pending = useImageIngestionContext(
    useCallback((state) => state.pending[image.id] ?? { attempts: 0, success: true }, [image.id])
  );
  const isBlocked = ingestionData.ingestion === ImageIngestionStatus.Blocked;
  const isLoading = pending.attempts < 5 && !pending.success;
  const loadingFailed = !isLoading && !ingestionData;

  const tags = useMemo(() => {
    if (!image.tags) return undefined;
    return image.tags.filter((x) => x.type === 'Moderation');
  }, [image.tags]);

  const showVotes =
    tags &&
    Array.isArray(tags) &&
    !!tags.length &&
    ingestionData.ingestion === ImageIngestionStatus.Scanned;

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
                        {!isBlocked && <ImageGuard.Report context="image" position="top-right" />}
                        <ImageGuard.ToggleImage position="top-left" />
                        <RoutedContextLink modal="imageDetailModal" imageId={image.id} {...filters}>
                          {!safe ? (
                            <AspectRatio ratio={(image?.width ?? 1) / (image?.height ?? 1)}>
                              <MediaHash {...image} />
                            </AspectRatio>
                          ) : (
                            <EdgeMedia
                              src={image.url}
                              className={cx({ [classes.blocked]: isBlocked })}
                              name={image.name ?? image.id.toString()}
                              alt={image.name ?? undefined}
                              type={image.type}
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
                        ) : ingestionData.ingestion !== ImageIngestionStatus.Blocked ? (
                          isLoading ? (
                            <Box className={classes.footer} p="xs" sx={{ width: '100%' }}>
                              <Stack spacing={4}>
                                <Group spacing={8} noWrap>
                                  <Loader size={20} />
                                  <Badge size="xs" color="yellow">
                                    Analyzing
                                  </Badge>
                                </Group>
                                <Text size="sm" inline>
                                  This image will be available to the community once processing is
                                  done.
                                </Text>
                              </Stack>
                            </Box>
                          ) : loadingFailed ? (
                            <Alert className={classes.info} variant="filled" color="yellow">
                              There are no tags associated with this image yet. Tags will be
                              assigned to this image soon.
                            </Alert>
                          ) : (
                            <Group className={classes.info} spacing={4} position="apart" noWrap>
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
                                  tippedAmountCount: image.stats?.tippedAmountCountAllTime,
                                }}
                                readonly={!safe}
                                className={classes.reactions}
                              />
                              {!image.hideMeta && image.meta && (
                                <ImageMetaPopover
                                  meta={image.meta}
                                  generationProcess={image.generationProcess ?? undefined}
                                  imageId={image.id}
                                >
                                  <ActionIcon variant="transparent" size="lg">
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
                            </Group>
                          )
                        ) : (
                          <Alert
                            color="red"
                            variant="filled"
                            radius={0}
                            className={classes.info}
                            title={
                              <Group spacing={4}>
                                <IconInfoCircle />
                                <Text inline>TOS Violation</Text>
                              </Group>
                            }
                          >
                            <Stack align="flex-end" spacing={0}>
                              <Text size="sm" inline>
                                The image you uploaded was determined to violate our TOS and will be
                                completely removed from our service.
                              </Text>
                            </Stack>
                          </Alert>
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
    bottom: 0,
    left: 0,
    width: '100%',
    padding: 5,
  },
  blocked: { opacity: 0.3 },
}));
