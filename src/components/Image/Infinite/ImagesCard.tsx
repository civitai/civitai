import { Alert, Anchor, Badge, Loader, Text, ThemeIcon } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconAlertTriangle, IconBrush, IconClock2, IconInfoCircle } from '@tabler/icons-react';
import { useCallback, useMemo, memo } from 'react';
import cardClasses from '~/components/Cards/Cards.module.css';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { RoutedDialogLink, triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { DurationBadge } from '~/components/DurationBadge/DurationBadge';
import { JudgeScoreBadge } from '~/components/Image/JudgeScoreBadge/JudgeScoreBadge';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { useImagesContext } from '~/components/Image/Providers/ImagesProvider';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ElementInView, useElementInView } from '~/components/IntersectionObserver/ElementInView';
import { Metrics } from '~/components/Metrics';
import { ImageBuzzTip, Reactions } from '~/components/Reaction/Reactions';
import { CardStickerOverlay } from '~/components/Sticker/CardStickerOverlay';
import { HatTimeLeft } from '~/components/HatTurf/HatTimeLeft';
import { HatTurfBadge } from '~/components/HatTurf/HatTurfBadge';
import { HatTurfButton } from '~/components/HatTurf/HatTurfButton';
import { HatTurfCardProvider } from '~/components/HatTurf/HatTurfCardProvider';
import { HatTurfLayer } from '~/components/HatTurf/HatTurfLayer';
import { useReactionNudgeClass } from '~/components/HatTurf/reaction-nudge';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { StickerPlacementCardBadge } from '~/components/Sticker/StickerPlacementCardBadge';
import { TwCard } from '~/components/TwCard/TwCard';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { getIsPublicBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { CollectionItemStatus, ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';
import { RemixMenu, isRemixMenuVisible } from '~/components/Image/Remix/RemixMenu';
import { MoreLikeThisButton } from '~/components/Image/MoreLikeThisButton';
import { REMIX_FRAME } from '~/components/RemixGallery/remix-card-state';
import { useRemixCardData } from '~/components/RemixGallery/use-remix-card-data';
import { RemixedCardFlyout } from '~/components/RemixGallery/RemixedCardFlyout';
import { tourClickThroughZIndex } from '~/shared/constants/app-layout.constants';
import { useImageStore } from '~/store/image.store';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { BlockedReason } from '~/server/common/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStorylineForPost } from '~/components/Storyline/StorylineBatchProvider';
import { StorylinePill } from '~/components/Storyline/StorylinePill';
import clsx from 'clsx';
import {
  getImagesCardFooterHeight,
  isImagesCardFooterOneRow,
} from '~/components/Image/Infinite/images-card-footer';
import classes from './ImagesCard.module.scss';

function getDialogState<T extends { id?: number }>(imageId: number, images: T[] = []) {
  const index = images.findIndex((x) => x.id === imageId);
  if (index === -1) return [];
  const minIndex = index - 50 > -1 ? index - 50 : 0;
  return images.slice(minIndex, index + 50);
}

export function ImagesCard({
  data,
  height,
  width,
}: {
  data: ImagesInfiniteModel;
  height: number;
  width?: number;
}) {
  return (
    <HatTurfCardProvider>
      <ImagesCardContent data={data} height={height} width={width} />
    </HatTurfCardProvider>
  );
}

function ImagesCardContent({
  data,
  height,
  width,
}: {
  data: ImagesInfiniteModel;
  height: number;
  width?: number;
}) {
  const { getImages, ...contextProps } = useImagesContext();
  const features = useFeatureFlags();
  const { running, helpers } = useTourContext();
  const currentUser = useCurrentUser();

  const image = useImageStore(data);
  const storyline = useStorylineForPost(image.postId);

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

  // Opening the menu must not follow the card's link to the image detail.
  const handleRemixClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // The content-gen tour spends two steps here — one on the button, one on the
  // options it opens — so both the open and the choice move it on by one.
  const advanceTour = useCallback(() => {
    if (running) helpers?.next();
  }, [running, helpers]);

  // The owner's own cosmetic wins; the remix frame is only a fallback.
  // The hook is called first and unconditionally — inside the `??` it sits after
  // a short-circuit, which is a conditional hook call.
  const remix = useRemixCardData(image.id);
  const cosmetic = image.cosmetic?.data ?? (remix.any ? REMIX_FRAME : undefined);

  const twCardStyle = useMemo(() => {
    return !cosmetic ? { height } : undefined;
  }, [cosmetic, height]);

  return (
    <TwCosmeticWrapper
      cosmetic={cosmetic}
      eventDecoration={image.eventDecoration?.data}
      eventDecorationOn={{ entityType: 'Image', entityId: image.id }}
      style={cosmetic ? { height } : undefined}
    >
      <ElementInView
        component={TwCard}
        style={twCardStyle}
        className="border"
        impressions={[{ entityType: 'Image', entityId: image.id }]}
      >
        <ImageGuard2 image={image}>
          {(safe) => (
            <>
              <div className="relative flex-1">
                <RoutedDialogLink
                  name="imageDetail"
                  state={{ imageId: image.id, ...contextProps }}
                  getState={() => ({
                    imageId: image.id,
                    images: getDialogState(image.id, getImages()),
                    ...contextProps,
                  })}
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
                      width={Math.max(450, width ?? 0)}
                      hiDpi={features.hiDpiPreviews}
                      sourceWidth={image.width}
                      placeholder="empty"
                      contain
                      loading="lazy"
                      imageId={image.id}
                      // fadeIn
                    />
                  ) : (
                    <MediaHash {...image} />
                  )}
                </RoutedDialogLink>
                {safe && features.stickerPlacement && (
                  <CardStickerOverlay
                    imageId={image.id}
                    revealStickers={contextProps.revealStickers}
                  />
                )}
                {safe && <HatTurfLayer imageId={image.id} />}
                {/* Steps clear of an event decoration sitting on the corner. */}
                <div className="absolute left-[max(0.5rem,var(--event-decoration-clear-left,0px))] top-2 z-[4] flex flex-nowrap items-center gap-1">
                  <HatTurfBadge imageId={image.id} />
                  {image.turfPlacedAt && (
                    <HatTimeLeft
                      placedAt={image.turfPlacedAt}
                      className="inline-flex h-6 items-center rounded-full bg-black/60 px-2 text-xs font-bold text-white"
                    />
                  )}
                  {/* This row's chips take the Hat Turf badge's 24px so they read as one line. */}
                  <ImageGuard2.BlurToggle radius="xl" h={24} style={{ pointerEvents: 'auto' }} />
                  {safe && storyline && (
                    <StorylinePill
                      title={storyline.title}
                      depth={storyline.depth}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        triggerRoutedDialog({
                          name: 'imageDetail',
                          state: {
                            imageId: image.id,
                            images: getDialogState(image.id, getImages()),
                            ...contextProps,
                            storylineChapterId: storyline.chapterId,
                          },
                        });
                      }}
                    />
                  )}
                  {safe &&
                    image.type === MediaType.video &&
                    image.metadata &&
                    'duration' in image.metadata && (
                      <DurationBadge duration={image.metadata.duration ?? 0} h={24} />
                    )}
                  {safe && image.judgeScore && (
                    <JudgeScoreBadge
                      score={image.judgeScore}
                      imageId={image.id}
                      judgeInfo={contextProps.judgeInfo}
                      judgingCategories={contextProps.judgingCategories}
                    />
                  )}
                  {isModerator && image.poi && (
                    <Badge variant="filled" radius="xl" h={26} color="pink.3">
                      POI
                    </Badge>
                  )}
                  {(currentUser?.id === data.user.id || isModerator) &&
                    data.collectionItemStatus === CollectionItemStatus.REVIEW && (
                      <Tooltip
                        label="Still being reviewed — not yet eligible for judging"
                        withinPortal
                      >
                        <Badge variant="filled" radius="xl" h={26} color="yellow">
                          Pending review
                        </Badge>
                      </Tooltip>
                    )}
                </div>
                {safe && (
                  <div className="absolute right-2 top-2 z-[4] flex flex-col gap-2">
                    {!isBlocked && <ImageContextMenu image={image} />}
                    {features.imageGeneration && isRemixMenuVisible(image) && (
                      <RemixMenu
                        image={image}
                        source="remix:image-card"
                        onAction={advanceTour}
                        onOpen={advanceTour}
                        tourTarget={image.type === MediaType.image ? 'gen:remix-menu' : undefined}
                        // The first of those has no footer, so the menu has to
                        // clear the layers Joyride draws over it.
                        zIndex={running ? tourClickThroughZIndex : undefined}
                      >
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
                      </RemixMenu>
                    )}
                    <MoreLikeThisButton image={image} />
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
                {safe && <RemixedCardFlyout imageId={image.id} />}

                {showVotes ? (
                  <div className={classes.footer}>
                    <VotableTags
                      entityType="image"
                      entityId={image.id}
                      tags={tags}
                      mediaType={image.type}
                    />
                  </div>
                ) : !isBlocked ? (
                  isPending ? (
                    <div
                      className={clsx(
                        classes.footer,
                        '!flex-col !items-stretch !justify-start gap-1 p-2'
                      )}
                    >
                      <div className="flex flex-nowrap items-center gap-2">
                        <Loader size={20} />
                        <Badge size="xs" color="yellow">
                          Analyzing
                        </Badge>
                      </div>
                      <Text size="sm" inline>
                        This image will be available to the community once processing is done.
                      </Text>
                    </div>
                  ) : (
                    <div className="absolute bottom-1 right-1">
                      {features.imageCardInfoButton && data.hasMeta && (
                        <ImageMetaPopover2 imageId={data.id} type={data.type}>
                          <div className="m-0.5 flex size-7 items-center justify-center rounded-full bg-black/50">
                            <IconInfoCircle
                              color="white"
                              opacity={0.9}
                              strokeWidth={2.5}
                              size={20}
                            />
                          </div>
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
                      <div className="flex items-center gap-1">
                        <IconInfoCircle />
                        <Text inline>Unable to verify AI generation</Text>
                      </div>
                    }
                  >
                    {image.postId && (
                      <Text size="sm" inline>
                        This image has been blocked because it is has received a NSFW rating and we
                        could not verify that it was generated using AI. To restore the image,
                        please{' '}
                        <Anchor c="yellow.8" href={`/posts/${image.postId}/edit`}>
                          update your post
                        </Anchor>{' '}
                        with metadata detailing the generation process &ndash; minimally the prompt
                        used.
                      </Text>
                    )}
                  </Alert>
                ) : (
                  <Alert
                    color="red"
                    variant="filled"
                    radius={0}
                    className="absolute bottom-0 left-0 w-full p-1"
                    title={
                      <div className="flex items-center gap-1">
                        <IconInfoCircle />
                        <Text inline>TOS Violation</Text>
                      </div>
                    }
                  >
                    <Text size="sm" inline>
                      The image you uploaded was determined to violate our TOS and will be
                      completely removed from our service.
                    </Text>
                  </Alert>
                )}
                {onSite && <OnsiteIndicator isRemix={isRemix} />}
              </div>
              {!contextProps.hideReactions && (
                <ImageReactions
                  width={width}
                  image={image}
                  readonly={!safe || (isScanned && isBlocked)}
                  showStickerBadge={features.stickerPlacement && !contextProps.hideStickerBadge}
                  safe={safe}
                />
              )}
            </>
          )}
        </ImageGuard2>
      </ElementInView>
    </TwCosmeticWrapper>
  );
}

export const ImagesCardMemoized = memo(ImagesCard);

// Shares the action-row layout (and its container query) with Cards/ImageCard via Cards.module.css.
function ImageReactions({
  width,
  image,
  readonly,
  showStickerBadge,
  safe,
}: {
  /** The card's width: it decides between one footer row and two. */
  width?: number;
  image: ImagesInfiniteModel;
  readonly: boolean;
  showStickerBadge: boolean;
  /** The hat layer only draws over shown media, so a blurred card gets no hat button either. */
  safe: boolean;
}) {
  // Read here, not in the card: a hat push re-renders every mounted card's row, but not the card.
  const turf = !!useTurfFeed() && safe;
  const inView = useElementInView();
  const oneRow = isImagesCardFooterOneRow(width);
  const nudge = useReactionNudgeClass({
    imageId: image.id,
    ownerId: image.user.id,
    reactions: image.reactions,
  });
  return (
    <Metrics
      entityType="Image"
      entityId={image.id}
      initial={{
        likeCount: image.stats?.likeCountAllTime ?? 0,
        dislikeCount: image.stats?.dislikeCountAllTime ?? 0,
        heartCount: image.stats?.heartCountAllTime ?? 0,
        laughCount: image.stats?.laughCountAllTime ?? 0,
        cryCount: image.stats?.cryCountAllTime ?? 0,
        tippedAmountCount: image.stats?.tippedAmountCountAllTime ?? 0,
      }}
      useLive={inView !== false}
    >
      {(metrics) => {
        // A read-only card with nothing to show renders no row at all, tip included.
        const hasReactions =
          !!image.stats?.statsUnknown ||
          image.reactions.length > 0 ||
          [
            metrics.likeCount,
            metrics.dislikeCount,
            metrics.heartCount,
            metrics.laughCount,
            metrics.cryCount,
          ].some((n) => (n ?? 0) > 0);
        return (
          <div
            className={clsx(cardClasses.footer, classes.actionsFooter)}
            style={{ ['--footer-height' as string]: `${getImagesCardFooterHeight(width)}px` }}
            onClick={(e) => {
              // The padding around the buttons must not open the card's image link.
              if (!readonly) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            <div
              className={clsx(cardClasses.actions, oneRow && [cardClasses.oneLine, classes.fitRow])}
            >
              <div className={cardClasses.actionRow}>
                <Reactions
                  className={clsx(
                    cardClasses.reactions,
                    classes.bar,
                    oneRow && classes.fitReactions,
                    nudge
                  )}
                  entityId={image.id}
                  entityType="image"
                  reactions={image.reactions}
                  metrics={metrics}
                  metricsUnknown={image.stats?.statsUnknown}
                  targetUserId={image.user.id}
                  readonly={readonly}
                  invisibleEmpty
                  disableBuzzTip
                  abbreviate
                />
              </div>
              <div className={cardClasses.tipRow}>
                {!image.poi && !(readonly && !hasReactions) && (
                  <ImageBuzzTip
                    entityId={image.id}
                    targetUserId={image.user.id}
                    tippedAmountCount={metrics.tippedAmountCount}
                    metricsUnknown={image.stats?.statsUnknown}
                    readonly={readonly}
                    className={clsx(cardClasses.reactions, classes.bar, 'flex items-center pl-0.5')}
                  />
                )}
                <div className={cardClasses.tipEnd}>
                  {showStickerBadge && <StickerPlacementCardBadge imageId={image.id} />}
                  {turf && <HatTurfButton imageId={image.id} />}
                </div>
              </div>
            </div>
          </div>
        );
      }}
    </Metrics>
  );
}
