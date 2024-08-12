import {
  ActionIcon,
  Alert,
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
import { ImageIngestionStatus } from '@prisma/client';
import { IconInfoCircle, IconBrush, IconAlertTriangle, IconClock2 } from '@tabler/icons-react';
import { useMemo } from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { Reactions } from '~/components/Reaction/Reactions';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { generationPanel } from '~/store/generation.store';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { useInView } from '~/hooks/useInView';
import { useImageStore } from '~/store/image.store';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { getIsPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { getSkipValue, shouldAnimateByDefault } from '~/components/EdgeMedia/EdgeMedia.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { TwCard } from '~/components/TwCard/TwCard';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';

export function ImagesCard({ data, height }: { data: ImagesInfiniteModel; height: number }) {
  const { ref, inView } = useInView({ rootMargin: '200% 0px' });
  const { classes, cx } = useStyles();
  const { classes: sharedClasses } = useCardStyles({ aspectRatio: 1 });
  const { images } = useImagesContext();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();

  const image = useImageStore(data);

  const isBlocked = image.ingestion === ImageIngestionStatus.Blocked;
  const isPending = image.ingestion === ImageIngestionStatus.Pending;
  const isScanned = image.ingestion === ImageIngestionStatus.Scanned;

  const tags = useMemo(() => {
    if (!image.tags) return undefined;
    return image.tags.filter((x) => !getIsPublicBrowsingLevel(x.nsfwLevel));
  }, [image.tags]);

  const showVotes = !!tags?.length && isScanned;

  const onSite = image.onSite;
  const notPublished = image.publishedAt === null;
  const scheduled = image.publishedAt && new Date(image.publishedAt) > new Date();

  const shouldAnimate = shouldAnimateByDefault({
    ...image,
    forceDisabled: !currentUser?.autoplayGifs,
  });

  return (
    <>
      <TwCosmeticWrapper cosmetic={image.cosmetic?.data}>
        <TwCard ref={ref} style={{ height }}>
          <ImageGuard2 image={image}>
            {(safe) => (
              <>
                <div
                  className="absolute inset-0 opacity-0 transition-opacity"
                  style={{ opacity: inView ? 1 : 0 }}
                >
                  {inView && (
                    <>
                      <div className="absolute left-2 top-2">
                        <ImageGuard2.BlurToggle />
                      </div>
                      {safe && (
                        <div className="absolute right-2 top-2 flex flex-col gap-2">
                          {!isBlocked && <ImageContextMenu image={image} />}
                          {features.imageGeneration && image.hasMeta && (
                            <HoverActionButton
                              label="Remix"
                              size={30}
                              color="white"
                              variant="filled"
                              data-activity="remix:image-card"
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
                        </div>
                      )}
                      <RoutedDialogLink name="imageDetail" state={{ imageId: image.id, images }}>
                        {safe ? (
                          <EdgeMedia
                            src={image.url}
                            className={cx(sharedClasses.image, { [classes.blocked]: isBlocked })}
                            name={image.name ?? image.id.toString()}
                            alt={image.name ?? undefined}
                            anim={shouldAnimate}
                            skip={getSkipValue(image)}
                            type={image.type}
                            width={450}
                            placeholder="empty"
                            fadeIn
                          />
                        ) : (
                          <MediaHash {...image} />
                        )}
                      </RoutedDialogLink>

                      {showVotes ? (
                        <div className={classes.footer}>
                          <VotableTags entityType="image" entityId={image.id} tags={tags} />
                        </div>
                      ) : !isBlocked ? (
                        isPending ? (
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
                        ) : (
                          <div className="absolute inset-x-1 bottom-1 flex items-center justify-between gap-1">
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
                            {data.hasMeta && (
                              <ImageMetaPopover2 imageId={data.id}>
                                <ActionIcon variant="transparent" size={30} component="span">
                                  <IconInfoCircle
                                    color="white"
                                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                                    opacity={0.8}
                                    strokeWidth={2.5}
                                    size={26}
                                  />
                                </ActionIcon>
                              </ImageMetaPopover2>
                            )}
                          </div>
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
                          <div className="flex flex-col items-end">
                            <Text size="sm" inline>
                              The image you uploaded was determined to violate our TOS and will be
                              completely removed from our service.
                            </Text>
                          </div>
                        </Alert>
                      )}
                      {onSite && <OnsiteIndicator />}
                    </>
                  )}
                </div>
              </>
            )}
          </ImageGuard2>
        </TwCard>
      </TwCosmeticWrapper>
    </>
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
      // backdropFilter: 'blur(5px) saturate(160%)',
      boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
      zIndex: 10,
      gap: 6,
      padding: theme.spacing.xs,
    },
    reactions: {
      borderRadius: theme.radius.sm,
      background:
        theme.colorScheme === 'dark'
          ? theme.fn.rgba(theme.colors.dark[6], 0.6)
          : theme.colors.gray[0],
      // backdropFilter: 'blur(5px) saturate(160%)',
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
  };
});
