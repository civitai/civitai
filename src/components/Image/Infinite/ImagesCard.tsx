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
  Tooltip,
  ThemeIcon,
} from '@mantine/core';
import { ImageIngestionStatus, CosmeticType } from '@prisma/client';
import { IconInfoCircle, IconBrush, IconAlertTriangle, IconClock2 } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImageIngestionContext } from '~/components/Image/Ingestion/ImageIngestionProvider';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Reactions } from '~/components/Reaction/Reactions';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { generationPanel } from '~/store/generation.store';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { useInView } from '~/hooks/useInView';
import { HolidayFrame } from '~/components/Decorations/HolidayFrame';

export function ImagesCard({ data: image, height }: { data: ImagesInfiniteModel; height: number }) {
  const { ref, inView } = useInView({ rootMargin: '200% 0px' });
  const { classes, cx } = useStyles();
  const { images } = useImagesContext();
  const features = useFeatureFlags();

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
  const isLoading = pending.attempts < 30 && !pending.success;
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

  const onSite = image.meta && 'civitaiResources' in image.meta;
  const notPublished = image.publishedAt === null;
  const scheduled = image.publishedAt && new Date(image.publishedAt) > new Date();

  const cardDecoration = image.user.cosmetics?.find(
    ({ cosmetic }) => cosmetic.type === CosmeticType.ContentDecoration
  ) as (typeof image.user.cosmetics)[number] & {
    data?: { lights?: number; upgradedLights?: number };
  };

  return (
    <HolidayFrame {...cardDecoration}>
      <RoutedDialogLink name="imageDetail" state={{ imageId: image.id, images }}>
        <MasonryCard withBorder shadow="sm" p={0} height={height} ref={ref}>
          <AspectRatio
            className={classes.blurHash}
            ratio={(image?.width ?? 1) / (image?.height ?? 1)}
          >
            <MediaHash {...image} />
          </AspectRatio>

          <div className={classes.content} style={{ opacity: inView ? 1 : 0 }}>
            {inView && (
              <>
                {onSite && <OnsiteIndicator />}
                <ImageGuard
                  images={[image]}
                  render={(image) => (
                    <ImageGuard.Content>
                      {({ safe }) => (
                        <>
                          <Group
                            position="apart"
                            align="start"
                            spacing={4}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              zIndex: 10,
                              padding: 8,
                            }}
                          >
                            <ImageGuard.ToggleImage position="static" />
                            <Stack spacing="xs" ml="auto">
                              {!isBlocked && (
                                <ImageGuard.Report context="image" position="static" />
                              )}
                              {features.imageGeneration && image.meta && (
                                <HoverActionButton
                                  label="Create"
                                  size={30}
                                  color="white"
                                  variant="filled"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    generationPanel.open({
                                      type: 'image',
                                      id: image.id,
                                    });
                                  }}
                                >
                                  <IconBrush stroke={2.5} size={16} />
                                </HoverActionButton>
                              )}
                              {scheduled && (
                                <Tooltip label="Scheduled">
                                  <ThemeIcon size={30} radius="xl" variant="filled" color="blue">
                                    <IconClock2 size={16} strokeWidth={2.5} />
                                  </ThemeIcon>
                                </Tooltip>
                              )}
                              {notPublished && (
                                <Tooltip label="Not published">
                                  <ThemeIcon size={30} radius="xl" variant="filled" color="yellow">
                                    <IconAlertTriangle size={16} strokeWidth={2.5} />
                                  </ThemeIcon>
                                </Tooltip>
                              )}
                            </Stack>
                          </Group>
                          {safe && (
                            <EdgeMedia
                              src={image.url}
                              className={cx({ [classes.blocked]: isBlocked })}
                              name={image.name ?? image.id.toString()}
                              alt={image.name ?? undefined}
                              type={image.type}
                              width={450}
                              placeholder="empty"
                              style={{ width: '100%' }}
                              fadeIn
                            />
                          )}

                          <div className="footer-abs">
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
                                      This image will be available to the community once processing
                                      is done.
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
                                    targetUserId={image.user.id}
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
                                    The image you uploaded was determined to violate our TOS and
                                    will be completely removed from our service.
                                  </Text>
                                </Stack>
                              </Alert>
                            )}
                          </div>
                        </>
                      )}
                    </ImageGuard.Content>
                  )}
                />
              </>
            )}
          </div>
        </MasonryCard>
      </RoutedDialogLink>
    </HolidayFrame>
  );
}

const useStyles = createStyles((theme, _, getRef) => {
  const footerRef = getRef('footer');
  const infoRef = getRef('info');

  return {
    title: {
      lineHeight: 1.1,
      fontSize: 14,
      color: 'white',
      fontWeight: 500,
    },
    footer: {
      ref: footerRef,

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
      backdropFilter: 'blur(5px) saturate(160%)',
      boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
      zIndex: 10,
      gap: 6,
      padding: theme.spacing.xs,
    },
    reactions: {
      borderRadius: theme.radius.sm,
      background: theme.fn.rgba(
        theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
        0.6
      ),
      backdropFilter: 'blur(5px) saturate(160%)',
      boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
      padding: 4,
    },
    info: {
      ref: infoRef,

      position: 'absolute',
      bottom: 0,
      left: 0,
      width: '100%',
      padding: 5,
    },
    blocked: { opacity: 0.3 },
    blurHash: {
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      zIndex: 1,
      opacity: 0.7,
    },
    content: {
      position: 'absolute',
      zIndex: 2,
      width: '100%',
      height: '100%',
      opacity: 0,
      transition: theme.other.fadeIn,
    },

    link: {
      [`&:has(~ .frame-decor) .${footerRef}, &:has(~ .frame-decor) .${infoRef}`]: {
        paddingBottom: '36px !important',
      },
    },
  };
});
