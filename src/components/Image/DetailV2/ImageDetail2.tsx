import type { ActionIconProps, BadgeProps, ButtonProps } from '@mantine/core';
import {
  Anchor,
  Badge,
  Button,
  Card,
  CloseButton,
  Group,
  RingProgress,
  ScrollArea,
  Text,
  useMantineTheme,
  rgba,
} from '@mantine/core';
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
  IconLayoutList,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconPhoto,
  IconShare3,
} from '@tabler/icons-react';
import { useRef } from 'react';
import clsx from 'clsx';
import { AdhesiveAd } from '~/components/Ads/AdhesiveAd';
import { AdUnitSide_2, AdUnitSide_3 } from '~/components/Ads/AdUnit';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { InteractiveTipBuzzButton } from '~/components/Buzz/InteractiveTipBuzzButton';
import { CarouselIndicators } from '~/components/Carousel/CarouselIndicators';
import { contestCollectionReactionsHidden } from '~/components/Collections/collection.utils';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { AppealDialog } from '~/components/Dialog/Common/AppealDialog';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { EdgeVideoRef } from '~/components/EdgeMedia/EdgeVideo';
import { EntityCollaboratorList } from '~/components/EntityCollaborator/EntityCollaboratorList';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageContestCollectionDetails } from '~/components/Image/DetailV2/ImageContestCollectionDetails';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { ImageExternalMeta } from '~/components/Image/DetailV2/ImageExternalMeta';
import { ImageGenerationData } from '~/components/Image/DetailV2/ImageGenerationData';
import { ImageProcess } from '~/components/Image/DetailV2/ImageProcess';
import { DownloadImage } from '~/components/Image/DownloadImage';
import { useImageContestCollectionDetails } from '~/components/Image/image.utils';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { Reactions } from '~/components/Reaction/Reactions';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { TrackView } from '~/components/TrackView/TrackView';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { env } from '~/env/client';
import { useCarouselNavigation } from '~/hooks/useCarouselNavigation';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { Availability, CollectionType, EntityType } from '~/shared/utils/prisma/enums';
import { generationPanel } from '~/store/generation.store';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { AdUnitOutstream } from '~/components/Ads/AdUnitOutstream';

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
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const {
    images,
    active,
    close,
    toggleInfo,
    shareUrl,
    connect,
    navigate,
    index,
    collection,
    hideReactions,
  } = useImageDetailContext();

  const [sidebarOpen, setSidebarOpen] = useLocalStorage({
    key: `image-detail-open`,
    defaultValue: true,
  });

  const videoRef = useRef<EdgeVideoRef | null>(null);
  const adContainerRef = useRef<HTMLDivElement | null>(null);

  const carouselNavigation = useCarouselNavigation({
    items: images,
    initialIndex: index,
    onChange: (image) => navigate(image.id),
  });

  const image = images[carouselNavigation.index];

  const { collectionItems, post } = useImageContestCollectionDetails(
    { id: image?.id as number },
    { enabled: !!image?.id }
  );

  if (!image) return <NotFound />;
  // Avoid showing POI images to non-mods non owners.
  if (image.poi && image.user.id !== currentUser?.id && !currentUser?.isModerator) {
    return <NotFound />;
  }

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

  const canCreate = image.hasPositivePrompt ?? image.hasMeta;
  const isOwner = currentUser?.id === image.user.id;

  const IconChevron = !active ? IconChevronUp : IconChevronDown;
  const IconLayoutSidebarRight = !sidebarOpen
    ? IconLayoutSidebarRightExpand
    : IconLayoutSidebarRightCollapse;

  const LeftImageControls = (
    <>
      {canCreate && (
        <Button
          {...sharedButtonProps}
          color="blue"
          onClick={() => generationPanel.open({ type: image.type, id: image.id })}
          data-activity="remix:image"
        >
          <Group gap={4} wrap="nowrap">
            <IconBrush size={16} />
            <Text size="xs">Remix</Text>
          </Group>
        </Button>
      )}
      <Button {...sharedButtonProps} onClick={handleSaveClick}>
        <IconBookmark {...sharedIconProps} />
        <Text size="xs" align="center" fw={500}>
          Save
        </Text>
      </Button>
      {image.postId && (
        <NextLink
          href={`/posts/${image.postId}`}
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
      {!image.poi && (
        <InteractiveTipBuzzButton toUserId={image.user.id} entityId={image.id} entityType="Image">
          <Badge
            {...sharedBadgeProps}
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
    </>
  );

  const title = `${image?.type === 'video' ? 'Video' : 'Image'} posted ${
    image.user.username ? `by ${image.user.username}` : 'to civitai'
  }`;

  return (
    <>
      <Meta
        title={title}
        images={image}
        links={[
          { href: `${env.NEXT_PUBLIC_BASE_URL as string}/images/${image.id}`, rel: 'canonical' },
        ]}
        deIndex={nsfw || !!image.needsReview || image.availability === Availability.Unsearchable}
      />
      <SensitiveShield contentNsfwLevel={forcedBrowsingLevel || image.nsfwLevel}>
        <TrackView entityId={image.id} entityType="Image" type="ImageView" nsfw={nsfw} />
        <BrowsingLevelProvider browsingLevel={image.nsfwLevel}>
          <BrowsingSettingsAddonsProvider>
            <div className="flex size-full max-h-full max-w-full flex-col overflow-hidden bg-gray-2 dark:bg-dark-9">
              <div className="relative flex flex-1 overflow-hidden">
                <div className="relative flex flex-1 flex-col @max-md:pb-[60px]">
                  <ImageGuard2 image={image} explain={false}>
                    {() => (
                      <>
                        {/* HEADER */}
                        <div className="flex justify-between gap-8 p-3">
                          <CloseButton
                            onClick={close}
                            variant="filled"
                            className="size-9 rounded-full"
                          />
                          <div className="flex flex-1 flex-wrap justify-between gap-1">
                            {/* Placeholder */}
                            <div className="@md:hidden" />
                            <div className="flex items-center gap-1 @max-md:hidden">
                              <ImageGuard2.BlurToggle {...sharedBadgeProps} />
                              {LeftImageControls}
                            </div>

                            <div className="flex items-center gap-1">
                              <ImageGuard2.BlurToggle
                                {...sharedBadgeProps}
                                className={clsx('@md:hidden', sharedBadgeProps.className)}
                              />
                              {/* Disable view count  */}
                              {/* <Badge {...sharedBadgeProps}>
                        <IconEye {...sharedIconProps} />
                        <Text size="xs" align="center" fw={500}>
                          {abbreviateNumber(image.stats?.viewCountAllTime ?? 0)}
                        </Text>
                      </Badge> */}
                              <DownloadImage src={image.url} type={image.type} name={image.name}>
                                {({ onClick, isLoading, progress }) => (
                                  <LegacyActionIcon
                                    {...sharedActionIconProps}
                                    onClick={onClick}
                                    loading={isLoading && progress === 0}
                                  >
                                    {isLoading && progress > 0 && (
                                      <RingProgress
                                        size={36}
                                        sections={[{ value: progress, color: 'blue' }]}
                                        thickness={4}
                                      />
                                    )}
                                    {!isLoading && <IconDownload {...sharedIconProps} />}
                                  </LegacyActionIcon>
                                )}
                              </DownloadImage>
                              <ShareButton
                                url={shareUrl}
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
                                  onClick={handleReportClick}
                                >
                                  <IconFlag {...sharedIconProps} />
                                </LegacyActionIcon>
                              </LoginRedirect>
                              <ImageContextMenu image={image}>
                                <LegacyActionIcon {...sharedActionIconProps}>
                                  <IconDotsVertical {...sharedIconProps} />
                                </LegacyActionIcon>
                              </ImageContextMenu>
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
                        <ImageDetailCarousel
                          images={images}
                          videoRef={videoRef}
                          connect={connect}
                          {...carouselNavigation}
                        />
                        {/* FOOTER */}
                        <div className="flex flex-col gap-3 p-3">
                          <div className="flex justify-center">
                            <ReactionSettingsProvider
                              settings={{
                                hideReactionCount: false,
                                hideReactions:
                                  hideReactions ||
                                  collectionItems.some((ci) =>
                                    contestCollectionReactionsHidden(ci.collection)
                                  ),
                                buttonStyling: (reaction, hasReacted) => ({
                                  radius: 'xl',
                                  variant: 'light',
                                  px: undefined,
                                  pl: 4,
                                  pr: 8,
                                  h: 30,
                                  style: {
                                    color: 'white',
                                    background: hasReacted
                                      ? rgba(theme.colors.blue[4], 0.4)
                                      : rgba(theme.colors.gray[8], 0.4),
                                    // backdropFilter: 'blur(7px)',
                                  },
                                }),
                              }}
                            >
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
                                disableBuzzTip={image.poi}
                              />
                            </ReactionSettingsProvider>
                          </div>
                          <CarouselIndicators {...carouselNavigation} />
                          {/* {viewportHeight >= 1050 && (
                      <AdUnitImageDetailBanner browsingLevel={image.nsfwLevel} />
                    )} */}
                        </div>
                      </>
                    )}
                  </ImageGuard2>
                </div>
                <div
                  className={`@max-md:absolute @max-md:inset-0 ${
                    !active
                      ? '@max-md:translate-y-[calc(100%-60px)]'
                      : '@max-md:transition-transform'
                  } @md:w-[450px] @md:min-w-[450px] ${
                    !sidebarOpen ? '@md:hidden' : ''
                  } z-10 flex flex-col bg-gray-2 dark:bg-dark-9`}
                  style={{ wordBreak: 'break-word' }}
                >
                  <div className="@max-md:shadow-topper flex items-center justify-between rounded-md p-3 @md:hidden">
                    <div className="flex gap-1">{LeftImageControls}</div>
                    <LegacyActionIcon {...sharedActionIconProps} onClick={toggleInfo}>
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
                        tipsEnabled={!image.poi}
                      />
                      {image.postId && (
                        <EntityCollaboratorList
                          entityId={image.postId}
                          entityType={EntityType.Post}
                          creatorCardProps={{
                            className: 'rounded-xl',
                            withActions: true,
                            tipsEnabled: !image.poi,
                          }}
                        />
                      )}
                      {image.needsReview && isOwner && (
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
                      {['AiNotVerified'].includes(image.blockedFor ?? '') && (
                        <AlertWithIcon
                          icon={<IconAlertTriangle />}
                          color="yellow"
                          iconColor="yellow"
                          title="Unable to verify AI generation"
                          radius={0}
                          px="md"
                        >
                          This image has been blocked because it is has received a NSFW rating and
                          we could not verify that it was generated using AI. To restore the image,
                          please update your post with metadata detailing the generation process
                          &ndash; such as the prompt, tools, and resources used.
                        </AlertWithIcon>
                      )}
                      {['Moderated', 'moderated'].includes(image.blockedFor ?? '') &&
                        !image.needsReview &&
                        isOwner && (
                          <AlertWithIcon
                            icon={<IconAlertTriangle />}
                            color="yellow"
                            iconColor="yellow"
                            title="Blocked by moderators"
                            radius={0}
                            px="md"
                          >
                            This image has been blocked by our moderators. We can make mistakes, if
                            you believe this was done in error,{' '}
                            <Anchor
                              type="button"
                              onClick={() =>
                                dialogStore.trigger({
                                  component: AppealDialog,
                                  props: { entityId: image.id, entityType: EntityType.Image },
                                })
                              }
                            >
                              appeal this removal
                            </Anchor>
                          </AlertWithIcon>
                        )}
                      {image.poi && (
                        <AlertWithIcon icon={<IconInfoCircle />} color="blue" iconColor="blue">
                          <Text>
                            This image was generated with AI and is based on the likeness of a real
                            person. It is not a photo, but because it depicts a real individual, it
                            cannot be monetized, used to display non-PG content, or shown alongside
                            X or XXX material. For more information, see our{' '}
                            <Anchor href="/safety">Content Policies</Anchor>
                          </Text>
                        </AlertWithIcon>
                      )}
                      {!hideAds && image.id !== 97016897 && <AdUnitSide_2 />}
                      {!hideAds && image.id === 97016897 && <AdUnitOutstream />}
                      <VotableTags
                        entityType="image"
                        entityId={image.id}
                        canAdd
                        collapsible
                        nsfwLevel={image.nsfwLevel}
                      />
                      {post && (post.title || post.detail) && (
                        <Card className="flex flex-col gap-3 rounded-xl">
                          <Text className="flex items-center gap-2 text-xl font-semibold">
                            <IconLayoutList />
                            <span>{post.title}</span>
                          </Text>
                          {post.detail && (
                            <ContentClamp maxHeight={75}>
                              <RenderHtml html={post.detail} />
                            </ContentClamp>
                          )}
                        </Card>
                      )}
                      <ImageProcess imageId={image.id} />
                      <ImageGenerationData imageId={image.id} />
                      {/* <ImageRemixOfDetails imageId={image.id} />
                    <ImageRemixesDetails imageId={image.id} /> */}
                      {/* {!hideAds && <AdUnitSide_3 />} */}
                      <Card className="flex flex-col gap-3 rounded-xl">
                        <Text className="flex items-center gap-2 text-xl font-semibold">
                          <IconBrandWechat />
                          <span>Discussion</span>
                        </Text>
                        <ImageDetailComments imageId={image.id} userId={image.user.id} />
                      </Card>
                      <ImageContestCollectionDetails
                        key={currentUser?.id}
                        image={image}
                        isOwner={isOwner}
                        isModerator={currentUser?.isModerator}
                        userId={currentUser?.id}
                      />
                      <ImageExternalMeta imageId={image.id} />
                    </div>
                  </ScrollArea>
                </div>
              </div>
              {!hideAds && <AdhesiveAd closeable={false} preserveLayout />}
            </div>
          </BrowsingSettingsAddonsProvider>
        </BrowsingLevelProvider>
      </SensitiveShield>
    </>
  );
}
