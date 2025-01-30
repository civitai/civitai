import {
  Alert,
  Badge,
  Box,
  createStyles,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconBrush, IconClock2, IconInfoCircle } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { DurationBadge } from '~/components/DurationBadge/DurationBadge';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { Reactions } from '~/components/Reaction/Reactions';
import { TwCard } from '~/components/TwCard/TwCard';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { useInView } from '~/hooks/useInView';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { getIsPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';
import { generationPanel } from '~/store/generation.store';
import { useImageStore } from '~/store/image.store';

export function ImagesCard({ data, height }: { data: ImagesInfiniteModel; height: number }) {
  const { classes, cx } = useStyles();
  const { classes: sharedClasses } = useCardStyles({ aspectRatio: 1 });
  const { images, ...contextProps } = useImagesContext();
  const features = useFeatureFlags();

  const image = useImageStore(data);
  const { ref, inView } = useInView({ key: image.cosmetic ? 1 : 0 });

  const isBlocked = image.ingestion === ImageIngestionStatus.Blocked;
  const isPending = image.ingestion === ImageIngestionStatus.Pending;
  const isScanned = image.ingestion === ImageIngestionStatus.Scanned;

  const tags = useMemo(() => {
    if (!image.tags) return undefined;
    return image.tags.filter((x) => !getIsPublicBrowsingLevel(x.nsfwLevel));
  }, [image.tags]);

  const showVotes = !!tags?.length && isScanned;

  const onSite = image.onSite;
  const isRemix = !!image.remixOfId;
  const notPublished = !image.publishedAt;
  const scheduled = image.publishedAt && new Date(image.publishedAt) > new Date();

  const handleRemixClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      generationPanel.open({
        type: image.type,
        id: image.id,
      });
    },
    [image.type, image.id]
  );

  const twCardStyle = useMemo(() => {
    return !image.cosmetic?.data ? { height } : undefined;
  }, [image.cosmetic, height]);

  const reactionMetrics = useMemo(
    () => ({
      likeCount: image.stats?.likeCountAllTime,
      dislikeCount: image.stats?.dislikeCountAllTime,
      heartCount: image.stats?.heartCountAllTime,
      laughCount: image.stats?.laughCountAllTime,
      cryCount: image.stats?.cryCountAllTime,
      tippedAmountCount: image.stats?.tippedAmountCountAllTime,
    }),
    [image.stats]
  );

  function getDialogState<T extends { id?: number }>(imageId: number, images: T[] = []) {
    const index = images.findIndex((x) => x.id === imageId);
    if (index === -1) return [];
    const minIndex = index - 50 > -1 ? index - 50 : 0;
    return images.slice(minIndex, index + 50);
  }

  return (
    <TwCosmeticWrapper
      cosmetic={image.cosmetic?.data}
      style={image.cosmetic?.data ? { height } : undefined}
    >
      <TwCard style={twCardStyle} ref={ref} className="border">
        {inView && (
          <ImageGuard2 image={image} inView={inView}>
            {(safe) => (
              <>
                <div className="relative flex-1">
                  <RoutedDialogLink
                    name="imageDetail"
                    state={{
                      imageId: image.id,
                      images: getDialogState(image.id, images),
                      ...contextProps,
                    }}
                    className="absolute inset-0"
                  >
                    {safe ? (
                      <EdgeMedia2
                        metadata={image.metadata}
                        src={image.url}
                        thumbnailUrl={image.thumbnailUrl}
                        className={cx(sharedClasses.image, { ['opacity-30']: isBlocked })}
                        name={image.name ?? image.id.toString()}
                        alt={image.name ?? undefined}
                        skip={getSkipValue(image)}
                        type={image.type}
                        wrapperProps={{ className: 'flex-1 h-full' }}
                        width={450}
                        placeholder="empty"
                        contain
                        // fadeIn
                      />
                    ) : (
                      <MediaHash {...image} />
                    )}
                  </RoutedDialogLink>
                  <div className="absolute left-2 top-2">
                    <div className="flex flex-nowrap items-center gap-1">
                      <ImageGuard2.BlurToggle radius="xl" h={26} sx={{ pointerEvents: 'auto' }} />
                      {safe &&
                        image.type === MediaType.video &&
                        image.metadata &&
                        'duration' in image.metadata && (
                          <DurationBadge duration={image.metadata.duration ?? 0} />
                        )}
                    </div>
                  </div>
                  {safe && (
                    <div className="absolute right-2 top-2 flex flex-col gap-2">
                      {!isBlocked && <ImageContextMenu image={image} />}
                      {features.imageGeneration && (image.hasPositivePrompt ?? image.hasMeta) && (
                        <HoverActionButton
                          label="Remix"
                          size={30}
                          color="white"
                          variant="filled"
                          data-activity="remix:image-card"
                          onClick={handleRemixClick}
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
                            This image will be available to the community once processing is done.
                          </Text>
                        </Stack>
                      </Box>
                    ) : (
                      <div className="absolute bottom-1 right-1">
                        {data.hasMeta && (
                          <ImageMetaPopover2 imageId={data.id} type={data.type}>
                            <IconInfoCircle
                              color="white"
                              filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                              opacity={0.8}
                              strokeWidth={2.5}
                              size={26}
                              className="m-0.5"
                            />
                          </ImageMetaPopover2>
                        )}
                      </div>
                    )
                  ) : (
                    <Alert
                      color="red"
                      variant="filled"
                      radius={0}
                      className="absolute bottom-0 left-0 w-full p-1"
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
                  {onSite && <OnsiteIndicator isRemix={isRemix} />}
                </div>
                <div>
                  <Reactions
                    entityId={image.id}
                    entityType="image"
                    reactions={image.reactions}
                    metrics={reactionMetrics}
                    targetUserId={image.user.id}
                    readonly={!safe || (isScanned && isBlocked)}
                    className={cx('justify-between p-2')}
                    invisibleEmpty
                  />
                </div>
              </>
            )}
          </ImageGuard2>
        )}
      </TwCard>
    </TwCosmeticWrapper>
  );
}

const useStyles = createStyles((theme) => {
  return {
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
      // backdropFilter: 'blur(5px) saturate(160%)',
      boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
      zIndex: 10,
      gap: 6,
      padding: theme.spacing.xs,
    },
  };
});
