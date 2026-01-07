import {
  Alert,
  Anchor,
  Badge,
  Box,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { IconAlertTriangle, IconBrush, IconClock2, IconInfoCircle } from '@tabler/icons-react';
import { useCallback, useMemo, memo } from 'react';
import cardClasses from '~/components/Cards/Cards.module.css';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
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
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { getIsPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';
import { generationPanel } from '~/store/generation.store';
import { useImageStore } from '~/store/image.store';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { BlockedReason } from '~/server/common/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import clsx from 'clsx';
import classes from './ImagesCard.module.scss';

export function ImagesCard({ data, height }: { data: ImagesInfiniteModel; height: number }) {
  const { getImages, ...contextProps } = useImagesContext();
  const features = useFeatureFlags();
  const { running, helpers } = useTourContext();
  const currentUser = useCurrentUser();

  const image = useImageStore(data);

  const isBlocked = image.ingestion === ImageIngestionStatus.Blocked || !!image.blockedFor;
  const isPending = image.ingestion === ImageIngestionStatus.Pending;
  const isScanned = image.ingestion === ImageIngestionStatus.Scanned;
  const isModerator = currentUser?.isModerator;

  const tags = useMemo(() => {
    if (!image.tags) return undefined;
    return image.tags.filter((x) => !getIsPublicBrowsingLevel(x.nsfwLevel));
  }, [image.tags]);

  const showVotes = !!tags?.length && isScanned;

  const onSite = image.onSite;
  const isRemix = !!image.remixOfId;
  const notPublished = !image.publishedAt;
  const scheduled = image.publishedAt && new Date(image.publishedAt) > new Date();
  const isBlockedForAiVerification = image.blockedFor === BlockedReason.AiNotVerified;

  const handleRemixClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      generationPanel.open({
        type: image.type,
        id: image.id,
      });

      // Go to next step in tour when clicking
      if (running) helpers?.next();
    },
    [image.type, image.id, running, helpers]
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
      <TwCard style={twCardStyle} className="border">
        <ImageGuard2 image={image}>
          {(safe) => (
            <>
              <div className="relative flex-1">
                <RoutedDialogLink
                  name="imageDetail"
                  state={{
                    imageId: image.id,
                    images: getDialogState(image.id, getImages()),
                    ...contextProps,
                  }}
                  className="absolute inset-0"
                >
                  {safe ? (
                    <EdgeMedia2
                      metadata={image.metadata}
                      src={image.url}
                      thumbnailUrl={image.thumbnailUrl}
                      className={clsx(cardClasses.image, { ['opacity-30']: isBlocked })}
                      name={image.name ?? image.id.toString()}
                      alt={image.name ?? undefined}
                      skip={getSkipValue(image)}
                      type={image.type}
                      wrapperProps={{ className: 'flex-1 h-full' }}
                      width={450}
                      placeholder="empty"
                      contain
                      loading="lazy"
                      // fadeIn
                    />
                  ) : (
                    <MediaHash {...image} />
                  )}
                </RoutedDialogLink>
                <div className="absolute left-2 top-2">
                  <div className="flex flex-nowrap items-center gap-1">
                    <ImageGuard2.BlurToggle radius="xl" h={26} style={{ pointerEvents: 'auto' }} />
                    {safe &&
                      image.type === MediaType.video &&
                      image.metadata &&
                      'duration' in image.metadata && (
                        <DurationBadge duration={image.metadata.duration ?? 0} />
                      )}
                    {isModerator && image.minor && (
                      <Badge variant="filled" radius="xl" h={26} color="pink.3">
                        Minor
                      </Badge>
                    )}
                    {isModerator && image.poi && (
                      <Badge variant="filled" radius="xl" h={26} color="pink.3">
                        POI
                      </Badge>
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
                        data-tour={image.type === MediaType.image ? 'gen:remix' : undefined}
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
                    <Box className={classes.footer} p="xs" style={{ width: '100%' }}>
                      <Stack gap={4}>
                        <Group gap={8} wrap="nowrap">
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
                ) : isBlockedForAiVerification ? (
                  <Alert
                    color="yellow"
                    // variant="filled"
                    radius={0}
                    className="absolute bottom-0 left-0 w-full p-2"
                    title={
                      <Group gap={4}>
                        <IconInfoCircle />
                        <Text inline>Unable to verify AI generation</Text>
                      </Group>
                    }
                  >
                    {image.postId && (
                      <div className="flex flex-col items-end">
                        <Text size="sm" inline>
                          This image has been blocked because it is has received a NSFW rating and
                          we could not verify that it was generated using AI. To restore the image,
                          please{' '}
                          <Anchor c="yellow.8" href={`/posts/${image.postId}/edit`}>
                            update your post
                          </Anchor>{' '}
                          with metadata detailing the generation process &ndash; minimally the
                          prompt used.
                        </Text>
                      </div>
                    )}
                  </Alert>
                ) : (
                  <Alert
                    color="red"
                    variant="filled"
                    radius={0}
                    className="absolute bottom-0 left-0 w-full p-1"
                    title={
                      <Group gap={4}>
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
              {!contextProps.hideReactions && (
                <div>
                  <Reactions
                    entityId={image.id}
                    entityType="image"
                    reactions={image.reactions}
                    metrics={reactionMetrics}
                    targetUserId={image.user.id}
                    readonly={!safe || (isScanned && isBlocked)}
                    className="justify-between p-2"
                    invisibleEmpty
                    disableBuzzTip={image.poi}
                  />
                </div>
              )}
            </>
          )}
        </ImageGuard2>
      </TwCard>
    </TwCosmeticWrapper>
  );
}

export const ImagesCardMemoized = memo(ImagesCard);
