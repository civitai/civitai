import { imageStatsToReactionMetrics } from '~/components/Reaction/image-reaction-metrics';
import type { ActionIconProps, BadgeProps, ButtonProps } from '@mantine/core';
import {
  Anchor,
  Badge,
  Button,
  CloseButton,
  Group,
  RingProgress,
  ScrollArea,
  Text,
  useMantineTheme,
  rgba,
} from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import { useLocalStorage } from '@mantine/hooks';
import type { IconProps } from '@tabler/icons-react';
import {
  IconAlertTriangle,
  IconBolt,
  IconBookmark,
  IconBrandWechat,
  IconBrush,
  IconChevronDown,
  IconChevronUp,
  IconDotsVertical,
  IconDownload,
  IconFlag,
  IconInfoCircle,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconPhoto,
  IconShare3,
} from '@tabler/icons-react';
import { useMemo, useRef } from 'react';
import {
  StorylineChapterDescription,
  StorylineStageOverlay,
  StorylineToolbarChip,
} from '~/components/Storyline/StorylineDetail';
import { StorylineChapterRail } from '~/components/Storyline/StorylineChapterRail';
import { useStorylineMode } from '~/components/Storyline/StorylineModeProvider';
import {
  getStorylineStep,
  withStorylineNavigation,
} from '~/components/Storyline/storyline-mode.utils';
import { useRouter } from 'next/router';
import clsx from 'clsx';
import { STICKER_REVEAL_PARAM, stickerRevealRequested } from '~/components/Placement/queue-routes';
import { useStickerRevealParam } from '~/store/sticker-reveal.store';
import { env } from '~/env/client';
import { AdhesiveAd } from '~/components/Ads/AdhesiveAd';
import { AdUnitSide_2 } from '~/components/Ads/AdUnit';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { InteractiveTipBuzzButton } from '~/components/Buzz/InteractiveTipBuzzButton';
import { CarouselIndicators } from '~/components/Carousel/CarouselIndicators';
import { contestCollectionReactionsHidden } from '~/components/Collections/collection.utils';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { OwnerBlockedImageNotice } from '~/components/Image/DetailV2/OwnerBlockedImageNotice';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { openReportModal } from '~/components/Dialog/triggers/report';
import type { EdgeVideoRef } from '~/components/EdgeMedia/EdgeVideo';
import { EntityCollaboratorList } from '~/components/EntityCollaborator/EntityCollaboratorList';
import { PostingToModel3DCard } from '~/components/Model3D/Posting/PostingToModel3DCard';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ReportChapterMenuItem } from '~/components/Storyline/ReportChapterMenuItem';
import { StorylineChapterRemoveItem } from '~/components/Storyline/StorylineChapterRemoveItem';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { CommentSection } from '~/components/CommentsV3/CommentSection';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { anchorImageIndex } from '~/components/Image/Detail/detail-items';
import { TextSlideMenu } from '~/components/Image/DetailV2/TextSlideMenu';
import { trpc } from '~/utils/trpc';
import { useCarouselUrlSync } from '~/components/Image/DetailV2/useCarouselUrlSync';
import { CollapsibleCard } from '~/components/Image/DetailV2/CollapsibleCard';
import { ImageDetailPostCard } from '~/components/Image/DetailV2/ImageDetailPostCard';
import { ImageContestCollectionDetails } from '~/components/Image/DetailV2/ImageContestCollectionDetails';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { isImageDetailPoiHidden } from '~/components/Image/DetailV2/image-detail-main-media';
import { ImageExternalMeta } from '~/components/Image/DetailV2/ImageExternalMeta';
import { ImageGenerationData } from '~/components/Image/DetailV2/ImageGenerationData';
import { ImagePublishedWithApp } from '~/components/Image/DetailV2/ImagePublishedWithApp';
import { RemixGalleryCard } from '~/components/RemixGallery/RemixGalleryCard';
import { ImageProcess } from '~/components/Image/DetailV2/ImageProcess';
import { ImageRemixOfDetails } from '~/components/Image/DetailV2/ImageRemixOfDetails';
import { DownloadImage } from '~/components/Image/DownloadImage';
import { useImageContestCollectionDetails } from '~/components/Image/image.utils';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { StickerPlacementBar } from '~/components/Sticker/StickerPlacementBar';
import {
  HatTurfDetailBadge,
  HatTurfDetailControls,
} from '~/components/HatTurf/detail/HatTurfDetailControls';
import {
  HatTurfDetailProvider,
  HatTurfDetailReset,
  takesHats,
} from '~/components/HatTurf/detail/HatTurfDetailProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Gated } from '~/components/Gated/Gated';
import { buildBreadcrumbSchema } from '~/components/Meta/site-schema';
import { buildImageMediaSchema } from '~/components/Image/DetailV2/image-media-schema';
import { imageDetailGateLevel } from '~/components/Image/DetailV2/image-detail-gate';
import { NextLink } from '~/components/NextLink/NextLink';
import { Metrics } from '~/components/Metrics';
import { Reactions } from '~/components/Reaction/Reactions';
import { useReactionNudgeClass } from '~/components/HatTurf/reaction-nudge';
import { ImageReactorsPreview } from '~/components/Reaction/ImageReactorsPreview';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { TrackView } from '~/components/TrackView/TrackView';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { Availability, CollectionType, EntityType } from '~/shared/utils/prisma/enums';
import { RemixMenu, isRemixMenuVisible } from '~/components/Image/Remix/RemixMenu';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { AdUnitOutstream } from '~/components/Ads/AdUnitOutstream';
import { ClientOnlySection } from '~/components/ClientOnlySection/ClientOnlySection';

const PREFETCH_THRESHOLD = 5;

const sharedBadgeProps: Partial<Omit<BadgeProps, 'children'>> = {
  variant: 'filled',
  color: 'gray',
  className: 'h-9 min-w-9 rounded-full normal-case',
  classNames: { label: 'flex gap-1 items-center' },
};

const sharedButtonProps: Partial<Omit<ButtonProps, 'children'>> = {
  variant: 'filled',
  color: 'gray',
  className: 'h-9 min-w-9 rounded-full normal-case',
  classNames: { label: 'flex gap-1 items-center' },
  px: 10,
};

const sharedActionIconProps: Partial<Omit<ActionIconProps, 'children'>> = {
  variant: 'filled',
  color: 'gray',
  className: 'h-9 w-9 rounded-full',
};

const sharedIconProps: IconProps = {
  size: 18,
  stroke: 2,
  color: 'white',
};

export function ImageDetail2() {
  const { images } = useImageDetailContext();
  return (
    <HatTurfDetailProvider images={images}>
      <ImageDetail2Content />
    </HatTurfDetailProvider>
  );
}

function ImageDetail2Content() {
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const {
    images,
    items,
    active,
    close,
    toggleInfo,
    shareUrl,
    connect,
    navigateTo,
    loadMore,
    hasMore,
    index,
    collection,
    hideReactions,
  } = useImageDetailContext();

  const [sidebarOpen, setSidebarOpen] = useLocalStorage({
    key: `image-detail-open`,
    defaultValue: true,
  });

  // Here rather than in the overlay: the overlay is behind the `safe` gate in
  // the carousel, so on a blurred image it never mounts and the link would
  // silently do nothing on exactly the images where the reveal matters most.
  //
  // 🔴 `next/router`, NOT the browser router, and deliberately. Every writer of
  // this param — the queue's `target="_blank"` link and the notification — is a
  // real page load, which is the only case `router.query` sees. Reading the
  // browser router instead would also cover a routed dialog opened over a feed,
  // and would flip `forced` on every carousel settle, which re-renders every
  // subscriber of the reveal store and writes localStorage each time (persist
  // does not diff). If a routed-dialog writer ever appears, that is the cost to
  // solve, and the answer is a second non-persisted store rather than a guard
  // inside the effect.
  useStickerRevealParam(stickerRevealRequested(useRouter().query[STICKER_REVEAL_PARAM]));

  const videoRef = useRef<EdgeVideoRef | null>(null);
  const adContainerRef = useRef<HTMLDivElement | null>(null);

  const carouselNavigation = useCarouselNavigation({ items, initialIndex: index });

  const storyline = useStorylineMode();
  // The header's `@max-md`, for the ⋯ menu, which is portaled out of the container.
  const narrowStage = useIsMobile({ breakpoint: 'md' });
  const isLastImage = getStorylineStep(carouselNavigation.index, items.length, 'next') === 'end';
  const navigation = withStorylineNavigation(
    carouselNavigation,
    items.length,
    storyline.active ? () => storyline.setEndOpen(true) : undefined,
    storyline.active && storyline.endOpen ? () => storyline.setEndOpen(false) : undefined
  );

  const settle = useCarouselUrlSync({
    items,
    index,
    navigate: navigateTo,
    carouselNavigate: carouselNavigation.navigate,
  });
  const handleSettle = (settledIndex: number) => {
    if (!settle(settledIndex)) return;
    // keep a runway ahead of the viewer so arrow/swipe navigation doesn't
    // dead-end (and loop back) at the edge of the loaded page
    if (hasMore && settledIndex >= items.length - PREFETCH_THRESHOLD) loadMore();
  };

  // On a text slide, `image` is the slide's anchor (the image its URL names) and `text` the slide;
  // everything about the image itself is left off. With no text items this is `images[index]`.
  const current = items[carouselNavigation.index];
  const text = current?.type === 'text' ? current.text : undefined;
  const anchorItem = items[anchorImageIndex(items, carouselNavigation.index)];
  const image = anchorItem?.type === 'image' ? anchorItem.image : undefined;
  const { data: textPost } = trpc.post.get.useQuery({ id: text?.postId ?? 0 }, { enabled: !!text });

  const railChapterIds = useMemo(
    () =>
      storyline.active
        ? items.map((item) =>
            item.type === 'image'
              ? storyline.chapterIdOfImage(item.image.id)
              : storyline.chapterIdOfPost(item.text.postId)
          )
        : undefined,
    [storyline, items]
  );

  // The address bar trails the carousel until it settles, so share the image
  // that's actually on screen rather than whatever the URL still says.
  const imageShareUrl = useMemo(() => {
    if (!image || text || items[index]?.key === current?.key) return shareUrl;
    const [, queryString] = shareUrl.split('?');
    return queryString ? `/images/${image.id}?${queryString}` : `/images/${image.id}`;
  }, [shareUrl, image, text, items, index, current?.key]);

  const { collectionItems, post } = useImageContestCollectionDetails(
    { id: image?.id as number },
    { enabled: !!image?.id }
  );

  if (!image) return <NotFound />;
  // Avoid showing POI images to non-mods non owners.
  if (isImageDetailPoiHidden(image, currentUser)) return <NotFound />;

  const actualCollection = collection || collectionItems[0]?.collection;
  const forcedBrowsingLevel = actualCollection?.metadata?.forcedBrowsingLevel;
  const nsfw = !getIsSafeBrowsingLevel(image.nsfwLevel);
  const hideAds = (image.poi || image.minor || actualCollection?.metadata?.hideAds) ?? false;

  const handleSaveClick = () =>
    openAddToCollectionModal({ props: { imageId: image.id, type: CollectionType.Image } });

  const handleReportClick = () => {
    openReportModal({
      entityType: ReportEntity.Image,
      entityId: image.id,
    });
  };

  const handleSidebarToggle = () => setSidebarOpen((o) => !o);

  const isOwner = currentUser?.id === image.user.id;
  const canRemix = isRemixMenuVisible(image);

  const IconChevron = !active ? IconChevronUp : IconChevronDown;
  const IconLayoutSidebarRight = !sidebarOpen
    ? IconLayoutSidebarRightExpand
    : IconLayoutSidebarRightCollapse;

  const reactionsHidden =
    hideReactions || collectionItems.some((ci) => contestCollectionReactionsHidden(ci.collection));

  const pillStyling =
    (h: number) =>
    (_reaction: unknown, hasReacted?: boolean): Omit<ButtonProps, 'onClick'> & BadgeProps => ({
      radius: 'xl',
      variant: 'light',
      px: undefined,
      pl: 4,
      pr: 8,
      h,
      style: {
        color: 'white',
        background: hasReacted ? rgba(theme.colors.blue[4], 0.4) : rgba(theme.colors.gray[8], 0.4),
      },
    });

  // `withStoryline` is the desktop toolbar; without it, the phone's bottom bar, where Remix and
  // Save are icon-only circles so the hat button and sticker pill fit beside them.
  const renderLeftImageControls = (withStoryline: boolean) => (
    <>
      {canRemix && !text && (
        <RemixMenu image={image} source="remix:image">
          {withStoryline ? (
            <Button {...sharedButtonProps} color="blue" data-activity="remix:image">
              <Group gap={4} wrap="nowrap">
                <IconBrush size={16} />
                <Text size="xs">Remix</Text>
              </Group>
            </Button>
          ) : (
            <LegacyActionIcon
              {...sharedActionIconProps}
              color="blue"
              data-activity="remix:image"
              aria-label="Remix"
            >
              <IconBrush {...sharedIconProps} />
            </LegacyActionIcon>
          )}
        </RemixMenu>
      )}
      {text ? null : withStoryline ? (
        <Button {...sharedButtonProps} onClick={handleSaveClick}>
          <IconBookmark {...sharedIconProps} />
          <Text size="xs" align="center" fw={500}>
            Save
          </Text>
        </Button>
      ) : (
        <LegacyActionIcon {...sharedActionIconProps} onClick={handleSaveClick} aria-label="Save">
          <IconBookmark {...sharedIconProps} />
        </LegacyActionIcon>
      )}
      {withStoryline && (
        <StorylineToolbarChip
          imageId={image.id}
          postId={text?.postId ?? image.postId ?? null}
          textPostId={text?.postId}
          placement="toolbar"
        />
      )}
      {(text?.postId ?? image.postId) && (
        <NextLink
          href={`/posts/${text?.postId ?? image.postId}`}
          className="hidden @md:block"
          onClick={() => {
            if (videoRef.current) videoRef.current.stop();
          }}
        >
          <Button {...sharedButtonProps}>
            <IconPhoto {...sharedIconProps} />
            <Text size="xs" align="center" fw={500}>
              View Post
            </Text>
          </Button>
        </NextLink>
      )}
      {/* On a phone the Buzz chip in the reaction row is the tip button, unless reactions are
          hidden: the chip goes with them, so the bar keeps a Tip circle. */}
      {!text && !withStoryline && reactionsHidden && !image.poi && (
        // The wrapper is the button; the circle inside it is a plain badge.
        <InteractiveTipBuzzButton
          toUserId={image.user.id}
          entityId={image.id}
          entityType="Image"
          aria-label="Tip"
          data-testid="image-detail-tip"
        >
          <Badge {...sharedBadgeProps} px={0} w={36}>
            <IconBolt size={18} fill={theme.colors.accent[5]} color={theme.colors.accent[5]} />
          </Badge>
        </InteractiveTipBuzzButton>
      )}
      {!text && withStoryline && !image.poi && (
        <InteractiveTipBuzzButton toUserId={image.user.id} entityId={image.id} entityType="Image">
          <Badge
            {...sharedBadgeProps}
            data-testid="image-detail-tip"
            pr={12}
            style={{
              fontSize: 12,
              fontWeight: 600,
              lineHeight: 1.5,
              color: theme.colors.accent[5],
            }}
          >
            <IconBolt size={14} fill="currentColor" />
            Tip
          </Badge>
        </InteractiveTipBuzzButton>
      )}
      {/* On a phone the badge is in the top toolbar, by Close, and the hat button is here. */}
      {!text && withStoryline && !narrowStage && takesHats(image) && (
        <HatTurfDetailBadge imageId={image.id} />
      )}
      {!text && !withStoryline && narrowStage && takesHats(image) && (
        <HatTurfDetailControls imageId={image.id} large />
      )}
      {/* Off the reaction row on a phone: beside the reactions it squeezed their counts. */}
      {!text && !withStoryline && narrowStage && (
        <ReactionSettingsProvider settings={{ buttonStyling: pillStyling(36) }}>
          <StickerPlacementBar imageId={image.id} imageNsfwLevel={image.nsfwLevel} />
        </ReactionSettingsProvider>
      )}
    </>
  );

  const isVideo = image?.type === 'video';
  const title = `${isVideo ? 'Video' : 'Image'} posted ${
    image.user.username ? `by ${image.user.username}` : 'to civitai'
  }`;

  const mediaSchema = buildImageMediaSchema({ image, title, baseUrl: env.NEXT_PUBLIC_BASE_URL });

  return (
    <Gated
      contentNsfwLevel={imageDetailGateLevel(image, forcedBrowsingLevel)}
      bypassRating={isOwner || !!currentUser?.isModerator}
      meta={{
        title,
        images: image,
        ogEndpoint: `/api/og?type=image&id=${image.id}`,
        canonical: `/images/${image.id}`,
        schema: mediaSchema,
        breadcrumb: buildBreadcrumbSchema(env.NEXT_PUBLIC_BASE_URL ?? '', [
          { name: isVideo ? 'Videos' : 'Images', path: isVideo ? '/videos' : '/images' },
          { name: title },
        ]),
        // Deindexed on every domain, videos included. The only per-page text is the prompt, which
        // stays out of search snippets, and indexed safe videos earned effectively no search
        // traffic over 2.5 months (GSC, Sep 2026). Video results come from the model, post and
        // article pages that embed the media — don't re-enable this without new evidence.
        deIndex: true,
      }}
    >
      <TrackView entityId={image.id} entityType="Image" type="ImageView" nsfw={nsfw} />
      <HatTurfDetailReset imageId={image.id} />
      <BrowsingLevelProvider browsingLevel={image.nsfwLevel}>
        <BrowsingSettingsAddonsProvider>
          <div className="flex size-full max-h-full max-w-full flex-col overflow-hidden bg-gray-2 dark:bg-dark-9">
            <div className="relative flex flex-1 overflow-hidden">
              <div className="relative flex flex-1 flex-col @max-md:min-w-0 @max-md:pb-[calc(60px+var(--safe-area-inset-bottom-unpaid))]">
                <ImageGuard2 image={image} explain={false}>
                  {() => (
                    <>
                      {/* HEADER */}
                      <div className="flex justify-between gap-3 p-3 @md:gap-8">
                        <div className="flex shrink-0 items-center gap-1">
                          <CloseButton
                            onClick={close}
                            variant="filled"
                            className="size-9 rounded-full"
                            data-testid="image-detail-close"
                          />
                          {!text && narrowStage && takesHats(image) && (
                            <HatTurfDetailBadge imageId={image.id} />
                          )}
                          {!text && (
                            <ImageGuard2.BlurToggle
                              {...sharedBadgeProps}
                              className={clsx('@md:hidden', sharedBadgeProps.className)}
                            />
                          )}
                        </div>
                        {/* One line on a phone: a wrapped row shrinks the image under it. */}
                        <div className="flex flex-1 flex-wrap justify-between gap-1 @max-md:min-w-0 @max-md:flex-nowrap">
                          <div className="flex min-w-0 items-center @md:hidden">
                            <StorylineToolbarChip
                              imageId={image.id}
                              postId={text?.postId ?? image.postId ?? null}
                              textPostId={text?.postId}
                              placement="mobile"
                            />
                          </div>
                          <div className="flex items-center gap-1 @max-md:hidden">
                            {!text && <ImageGuard2.BlurToggle {...sharedBadgeProps} />}
                            {renderLeftImageControls(true)}
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            {/* Disable view count  */}
                            {/* <Badge {...sharedBadgeProps}>
                        <IconEye {...sharedIconProps} />
                        <Text size="xs" align="center" fw={500}>
                          {abbreviateNumber(image.stats?.viewCountAllTime ?? 0)}
                        </Text>
                      </Badge> */}
                            {/* Wraps the ⋯ menu so a download outlives the menu closing. On a phone, Download is in
                                the menu, and so is Report image. */}
                            {text ? (
                              <>
                                <ShareButton url={imageShareUrl} title={title}>
                                  <LegacyActionIcon {...sharedActionIconProps}>
                                    <IconShare3 {...sharedIconProps} />
                                  </LegacyActionIcon>
                                </ShareButton>
                                <TextSlideMenu postId={text.postId}>
                                  <LegacyActionIcon {...sharedActionIconProps}>
                                    <IconDotsVertical {...sharedIconProps} />
                                  </LegacyActionIcon>
                                </TextSlideMenu>
                              </>
                            ) : (
                              <DownloadImage src={image.url} type={image.type} name={image.name}>
                                {({ onClick: download, isLoading: downloading, progress }) => (
                                  <>
                                    <LegacyActionIcon
                                      {...sharedActionIconProps}
                                      className={clsx(
                                        sharedActionIconProps.className,
                                        '@max-md:hidden'
                                      )}
                                      onClick={download}
                                      loading={downloading && progress === 0}
                                    >
                                      {downloading && progress > 0 && (
                                        <RingProgress
                                          size={36}
                                          sections={[{ value: progress, color: 'blue' }]}
                                          thickness={4}
                                        />
                                      )}
                                      {!downloading && <IconDownload {...sharedIconProps} />}
                                    </LegacyActionIcon>
                                    <ShareButton
                                      url={imageShareUrl}
                                      title={title}
                                      collect={{ type: CollectionType.Image, imageId: image.id }}
                                    >
                                      <LegacyActionIcon {...sharedActionIconProps}>
                                        <IconShare3 {...sharedIconProps} />
                                      </LegacyActionIcon>
                                    </ShareButton>
                                    <LoginRedirect reason={'report-content'}>
                                      <LegacyActionIcon
                                        {...sharedActionIconProps}
                                        className={clsx(
                                          sharedActionIconProps.className,
                                          '@max-md:hidden'
                                        )}
                                        onClick={handleReportClick}
                                      >
                                        <IconFlag {...sharedIconProps} />
                                      </LegacyActionIcon>
                                    </LoginRedirect>
                                    <ImageContextMenu
                                      image={image}
                                      additionalMenuItems={
                                        <>
                                          {narrowStage && (
                                            <Menu.Item
                                              leftSection={<IconDownload size={14} stroke={1.5} />}
                                              onClick={download}
                                              disabled={downloading}
                                              closeMenuOnClick={false}
                                            >
                                              {!downloading
                                                ? 'Download'
                                                : Number.isFinite(progress) && progress > 0
                                                ? `Downloading ${Math.round(progress)}%`
                                                : 'Downloading…'}
                                            </Menu.Item>
                                          )}
                                          {storyline.active &&
                                            !isOwner &&
                                            !!image.postId &&
                                            storyline.chapterIdOfImage(image.id) !== undefined && (
                                              <ReportChapterMenuItem postId={image.postId} />
                                            )}
                                          <StorylineChapterRemoveItem imageId={image.id} />
                                        </>
                                      }
                                    >
                                      <LegacyActionIcon {...sharedActionIconProps}>
                                        <IconDotsVertical {...sharedIconProps} />
                                      </LegacyActionIcon>
                                    </ImageContextMenu>
                                  </>
                                )}
                              </DownloadImage>
                            )}
                          </div>
                        </div>
                        <div className={`@max-md:hidden ${sidebarOpen ? '-mr-3 ml-3' : ''}`}>
                          <LegacyActionIcon
                            {...sharedActionIconProps}
                            onClick={handleSidebarToggle}
                          >
                            <IconLayoutSidebarRight {...sharedIconProps} />
                          </LegacyActionIcon>
                        </div>
                      </div>

                      {/* IMAGE CAROUSEL */}
                      <div className="relative flex min-h-0 flex-1 flex-col">
                        <ImageDetailCarousel
                          images={images}
                          items={items}
                          textUserId={textPost?.user.id ?? image.user.id}
                          videoRef={videoRef}
                          connect={connect}
                          onSettle={handleSettle}
                          loop={!storyline.active}
                          {...navigation}
                        />
                        <StorylineStageOverlay
                          isLastImage={isLastImage}
                          imageId={text ? undefined : image?.id}
                        />
                      </div>
                      {/* FOOTER */}
                      <div className="flex flex-col gap-3 p-3">
                        <StorylineChapterDescription
                          imageId={image?.id}
                          textPostId={text?.postId}
                        />
                        <div className={clsx('flex justify-center', text && 'hidden')}>
                          <ReactionSettingsProvider
                            settings={{
                              hideReactionCount: false,
                              hideReactions: reactionsHidden,
                              buttonStyling: pillStyling(30),
                            }}
                          >
                            <ImageDetailReactions image={image} />
                            {/* On a phone it is in the bottom bar. */}
                            {!narrowStage && (
                              <StickerPlacementBar
                                imageId={image.id}
                                imageNsfwLevel={image.nsfwLevel}
                                className="ml-2"
                              />
                            )}
                            {!narrowStage && takesHats(image) && (
                              <div className="ml-2">
                                <HatTurfDetailControls imageId={image.id} />
                              </div>
                            )}
                          </ReactionSettingsProvider>
                        </div>
                        {storyline.active ? (
                          <StorylineChapterRail
                            storyline={storyline}
                            images={images}
                            chapterIds={railChapterIds}
                            index={carouselNavigation.index}
                            navigate={carouselNavigation.navigate}
                          />
                        ) : (
                          <CarouselIndicators {...carouselNavigation} />
                        )}
                        {/* {viewportHeight >= 1050 && (
                      <AdUnitImageDetailBanner />
                    )} */}
                      </div>
                    </>
                  )}
                </ImageGuard2>
              </div>
              <div
                className={`@max-md:absolute @max-md:inset-0 ${
                  !active
                    ? // COLLAPSED, and on `/images/[imageId]` this 60px strip is the
                      // bottom of the layout viewport whenever `hideAds` suppresses
                      // the ad bar below it — the route passes `footer: null`, so
                      // nothing else is down there. The strip has to grow by the
                      // inset or its controls sit 12px above the physical bottom,
                      // i.e. inside the home indicator. Same expression as the
                      // header row's padding just below, so the strip stays exactly
                      // that row and no scroll content peeks under the indicator.
                      //
                      // `…-unpaid` and not the raw inset: when the ad bar DOES
                      // render it is the viewport bottom and pays for itself, and
                      // this panel is back to being an ordinary box above it.
                      '@max-md:translate-y-[calc(100%-60px-var(--safe-area-inset-bottom-unpaid))]'
                    : '@max-md:transition-transform'
                } @md:w-[450px] @md:min-w-[450px] ${
                  !sidebarOpen ? '@md:hidden' : ''
                } z-10 flex flex-col bg-gray-2 dark:bg-dark-9`}
                style={{ wordBreak: 'break-word' }}
                data-testid="image-detail-sheet"
              >
                {/* The padding is on the `!active` branch only. Expanded, this row
                    is at the TOP of the panel and the inset below it would be a
                    spurious 34px gap — over-payment, which is a defect here in
                    exactly the way under-payment is. */}
                <div
                  className={`@max-md:shadow-topper flex items-center justify-between rounded-md p-3 @md:hidden ${
                    !active ? '@max-md:pb-[calc(0.75rem+var(--safe-area-inset-bottom-unpaid))]' : ''
                  }`}
                >
                  <div className="flex items-center gap-1">{renderLeftImageControls(false)}</div>
                  <LegacyActionIcon
                    {...sharedActionIconProps}
                    onClick={toggleInfo}
                    data-testid="image-detail-chevron"
                  >
                    <IconChevron {...sharedIconProps} />
                  </LegacyActionIcon>
                </div>
                <ScrollArea className="flex-1 p-3 py-0">
                  <div className="flex flex-col gap-3 py-3 @max-md:pt-0" ref={adContainerRef}>
                    <SmartCreatorCard
                      user={image.user}
                      subText={
                        <Text size="xs" c="dimmed">
                          {image.publishedAt || image.sortAt ? (
                            <>
                              Uploaded <DaysFromNow date={image.publishedAt || image.sortAt} />
                            </>
                          ) : (
                            'Not published'
                          )}
                        </Text>
                      }
                      tipBuzzEntityId={image.id}
                      tipBuzzEntityType="Image"
                      className="rounded-xl"
                      tipsEnabled={!image.poi && !text}
                    />
                    {/* Beside, not inside, the creator card: the card's subText sits
                        inside the profile link on the cosmetic-shop card, and an
                        anchor cannot nest in an anchor. */}
                    {!text && <ImagePublishedWithApp imageId={image.id} />}
                    {(text?.postId ?? image.postId) && (
                      <EntityCollaboratorList
                        entityId={(text?.postId ?? image.postId) as number}
                        entityType={EntityType.Post}
                        creatorCardProps={{
                          className: 'rounded-xl',
                          withActions: true,
                          tipsEnabled: !image.poi,
                        }}
                      />
                    )}
                    {!text && image.postId && (
                      // Durable data-gate: BOTH the `image.get` payload (direct
                      // image-page path) AND the feed payloads (getAllImages /
                      // getAllImagesIndex, the feed-modal path) now carry the
                      // visibility-checked `model3dId`, so the chip renders from
                      // the prop and never fires the ambient
                      // `model3d.getByPostId` query. A Meili-sourced feed item
                      // with no link resolves to `null` (chip hidden, no
                      // fallback), so the #2682 model3dFeed flag-gate is
                      // redundant now.
                      <PostingToModel3DCard
                        model3dId={(image as { model3dId?: number | null }).model3dId}
                        postId={image.postId}
                        label="Posted to 3D Model"
                      />
                    )}
                    {!text && image.needsReview && isOwner && (
                      <AlertWithIcon
                        icon={<IconAlertTriangle />}
                        color="yellow"
                        iconColor="yellow"
                        title={
                          image.needsReview === 'appeal' ? 'Under appeal' : 'Flagged for review'
                        }
                        radius={0}
                        px="md"
                      >
                        {image.needsReview === 'appeal'
                          ? `Your appeal has been submitted, but the image will remain hidden until it's reviewed by our moderators.`
                          : `This image won't be visible to other users until it's reviewed by our moderators.`}
                      </AlertWithIcon>
                    )}
                    {!text && ['AiNotVerified'].includes(image.blockedFor ?? '') && (
                      <AlertWithIcon
                        icon={<IconAlertTriangle />}
                        color="yellow"
                        iconColor="yellow"
                        title="Unable to verify AI generation"
                        radius={0}
                        px="md"
                      >
                        This image has been blocked because it is has received a NSFW rating and we
                        could not verify that it was generated using AI. To restore the image,
                        please update your post with metadata detailing the generation process
                        &ndash; such as the prompt, tools, and resources used.
                      </AlertWithIcon>
                    )}
                    {!text && isOwner && <OwnerBlockedImageNotice image={image} />}
                    {!text && image.poi && (
                      <AlertWithIcon icon={<IconInfoCircle />} color="blue" iconColor="blue">
                        <Text>
                          This image was generated with AI and is based on the likeness of a real
                          person. It is not a photo, but because it depicts a real individual, it
                          cannot be monetized, used to display non-PG content, or shown alongside
                          mature material. For more information, see our{' '}
                          <Anchor href="/safety">Content Policies</Anchor>
                        </Text>
                      </AlertWithIcon>
                    )}
                    {!hideAds && image.id !== 97016897 && <AdUnitSide_2 />}
                    {!hideAds && image.id === 97016897 && <AdUnitOutstream />}
                    {/* `ssr-client-only-sections`: the page is deindexed (see `deIndex` above), so
                        nothing below is read by search engines, and it is the tail of the sidebar,
                        so its arrival after hydration moves nothing above it. */}
                    <ClientOnlySection name="image-detail-sidebar" minHeight={320}>
                      {text ? (
                        <>
                          <ImageDetailPostCard post={textPost} />
                          <CollapsibleCard
                            title="Discussion"
                            icon={<IconBrandWechat />}
                            storageKey="discussion"
                          >
                            {textPost && (
                              <CommentSection
                                entityType="postText"
                                entityId={text.id}
                                ownerId={textPost.user.id}
                                title={null}
                                hideSort
                                borderless
                              />
                            )}
                          </CollapsibleCard>
                        </>
                      ) : (
                        <>
                          <VotableTags
                            entityType="image"
                            entityId={image.id}
                            canAdd
                            collapsible
                            nsfwLevel={image.nsfwLevel}
                            mediaType={image.type}
                          />
                          <ImageDetailPostCard post={post} />
                          <ImageProcess imageId={image.id} />
                          <ImageRemixOfDetails imageId={image.id} />
                          <RemixGalleryCard imageId={image.id} />
                          <ImageGenerationData imageId={image.id} collapsible />
                          <CollapsibleCard
                            title="Discussion"
                            icon={<IconBrandWechat />}
                            storageKey="discussion"
                          >
                            <ImageDetailComments imageId={image.id} userId={image.user.id} />
                          </CollapsibleCard>
                          <ImageContestCollectionDetails
                            key={currentUser?.id}
                            image={image}
                            isOwner={isOwner}
                            isModerator={currentUser?.isModerator}
                            userId={currentUser?.id}
                          />
                          <ImageExternalMeta imageId={image.id} />
                        </>
                      )}
                    </ClientOnlySection>
                  </div>
                </ScrollArea>
              </div>
            </div>
            {!hideAds && <AdhesiveAd closeable={false} preserveLayout />}
          </div>
        </BrowsingSettingsAddonsProvider>
      </BrowsingLevelProvider>
    </Gated>
  );
}

function ImageDetailReactions({
  image,
}: {
  image: ReturnType<typeof useImageDetailContext>['images'][number];
}) {
  const nudge = useReactionNudgeClass({
    imageId: image.id,
    ownerId: image.user.id,
    reactions: image.reactions,
  });
  return (
    <Metrics
      entityType="Image"
      entityId={image.id}
      initial={imageStatsToReactionMetrics(image.stats)}
    >
      {(metrics) => (
        <ImageReactorsPreview imageId={image.id} ownerId={image.user.id}>
          <Reactions
            entityId={image.id}
            entityType="image"
            reactions={image.reactions}
            metrics={metrics}
            metricsUnknown={image.stats?.statsUnknown}
            targetUserId={image.user.id}
            disableBuzzTip={image.poi}
            // Wrap, never shrink: a shrunk pill cuts its count off.
            className={clsx('flex-wrap', nudge)}
          />
        </ImageReactorsPreview>
      )}
    </Metrics>
  );
}
