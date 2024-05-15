import {
  ActionIcon,
  ActionIconProps,
  Badge,
  BadgeProps,
  Button,
  ButtonProps,
  Card,
  CloseButton,
  Group,
  ScrollArea,
  Text,
  useMantineTheme,
} from '@mantine/core';
import { Availability, CollectionType } from '@prisma/client';
import {
  IconAlertTriangle,
  IconBookmark,
  IconBrandWechat,
  IconChevronDown,
  IconChevronUp,
  IconDotsVertical,
  IconEye,
  IconFlag,
  IconLayoutSidebarRightCollapse,
  IconLayoutSidebarRightExpand,
  IconPhoto,
  IconShare3,
  TablerIconsProps,
} from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { ImageDetailContextMenu } from '~/components/Image/Detail/ImageDetailContextMenu';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { TrackView } from '~/components/TrackView/TrackView';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { env } from '~/env/client.mjs';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { abbreviateNumber } from '~/utils/number-helpers';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { IconBrush } from '@tabler/icons-react';
import { generationPanel } from '~/store/generation.store';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { useLocalStorage } from '@mantine/hooks';

import { ImageGenerationData } from '~/components/Image/DetailV2/ImageGenerationData';
import { ImageProcess } from '~/components/Image/DetailV2/ImageProcess';

const sharedBadgeProps: Partial<Omit<BadgeProps, 'children'>> = {
  variant: 'filled',
  color: 'gray',
  className: 'h-9 min-w-9 rounded-full normal-case',
  classNames: { inner: 'flex gap-1 items-center' },
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

const sharedIconProps: TablerIconsProps = {
  size: 18,
  stroke: 2,
  color: 'white',
};

export function ImageDetail2() {
  const theme = useMantineTheme();
  const { image: image, isLoading, active, close, toggleInfo, shareUrl } = useImageDetailContext();
  const [sidebarOpen, setSidebarOpen] = useLocalStorage({
    key: `image-detail-open`,
    defaultValue: true,
  });

  if (isLoading) return <PageLoader />;
  if (!image) return <NotFound />;

  const nsfw = !getIsSafeBrowsingLevel(image.nsfwLevel);

  const handleSaveClick = () =>
    openContext('addToCollection', { imageId: image.id, type: CollectionType.Image });

  const handleReportClick = () => {
    openContext('report', {
      entityType: ReportEntity.Image,
      entityId: image.id,
    });
  };

  const handleSidebarToggle = () => setSidebarOpen((o) => !o);

  const canCreate = !!image.meta?.prompt && !image.hideMeta;

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
          onClick={() => generationPanel.open({ type: 'image', id: image.id })}
          data-activity="remix:image"
        >
          <div className="glow" />
          <Group spacing={4} noWrap>
            <IconBrush size={16} />
            <Text size="xs">Remix</Text>
          </Group>
        </Button>
      )}
      <Button {...sharedButtonProps} onClick={handleSaveClick}>
        <IconBookmark {...sharedIconProps} />
        <Text color="white" size="xs" align="center" weight={500}>
          Save
        </Text>
      </Button>
      {image.postId && (
        <RoutedDialogLink
          name="postDetail"
          state={{ postId: image.postId }}
          className="hidden @md:block"
        >
          <Button {...sharedButtonProps}>
            <IconPhoto {...sharedIconProps} />
            <Text color="white" size="xs" align="center" weight={500}>
              View Post
            </Text>
          </Button>
        </RoutedDialogLink>
      )}
      <TipBuzzButton
        {...sharedButtonProps}
        toUserId={image.user.id}
        entityId={image.id}
        entityType="Image"
      />
    </>
  );

  return (
    <>
      <Meta
        title={`Image posted by ${image.user.username}`}
        images={image}
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/images/${image.id}`, rel: 'canonical' }]}
        deIndex={nsfw || !!image.needsReview || image.availability === Availability.Unsearchable}
      />
      <TrackView entityId={image.id} entityType="Image" type="ImageView" nsfw={nsfw} />
      <div className="h-full w-full max-w-full max-h-full flex bg-gray-2 dark:bg-dark-9 relative overflow-hidden">
        <div className="flex-1 flex flex-col relative @max-md:pb-[60px]">
          <ImageGuard2 image={image} explain={false}>
            {(safe) => (
              <>
                {/* HEADER */}
                <div className="flex justify-between gap-8 p-3">
                  <CloseButton onClick={close} variant="filled" className="h-9 w-9 rounded-full" />
                  <div className="flex flex-wrap justify-between gap-1 flex-1">
                    {/* Placeholder */}
                    <div className="@md:hidden" />
                    <div className="@max-md:hidden flex gap-1">
                      <ImageGuard2.BlurToggle {...sharedBadgeProps} />
                      {LeftImageControls}
                    </div>

                    <div className="flex gap-1">
                      <ImageGuard2.BlurToggle
                        {...sharedBadgeProps}
                        className={`${sharedBadgeProps.className} @md:hidden`}
                      />
                      <Badge {...sharedBadgeProps}>
                        <IconEye {...sharedIconProps} />
                        <Text color="white" size="xs" align="center" weight={500}>
                          {abbreviateNumber(image.stats?.viewCountAllTime ?? 0)}
                        </Text>
                      </Badge>
                      <ShareButton
                        url={shareUrl}
                        title={`Image by ${image.user.username}`}
                        collect={{ type: CollectionType.Image, imageId: image.id }}
                      >
                        <ActionIcon {...sharedActionIconProps}>
                          <IconShare3 {...sharedIconProps} />
                        </ActionIcon>
                      </ShareButton>
                      <LoginRedirect reason={'report-content'}>
                        <ActionIcon {...sharedActionIconProps} onClick={handleReportClick}>
                          <IconFlag {...sharedIconProps} />
                        </ActionIcon>
                      </LoginRedirect>
                      <ImageDetailContextMenu>
                        <ActionIcon {...sharedActionIconProps}>
                          <IconDotsVertical {...sharedIconProps} />
                        </ActionIcon>
                      </ImageDetailContextMenu>
                    </div>
                  </div>
                  <div className={`@max-md:hidden ${sidebarOpen ? 'ml-3 -mr-3' : ''}`}>
                    <ActionIcon {...sharedActionIconProps} onClick={handleSidebarToggle}>
                      <IconLayoutSidebarRight {...sharedIconProps} />
                    </ActionIcon>
                  </div>
                </div>
                {/* IMAGE CAROUSEL */}
                <ImageDetailCarousel />
                {/* FOOTER */}
                <div className="flex justify-center p-3">
                  <ReactionSettingsProvider
                    settings={{
                      hideReactionCount: false,
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
                            ? theme.fn.rgba(theme.colors.blue[4], 0.4)
                            : theme.fn.rgba(theme.colors.gray[8], 0.4),
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
                    />
                  </ReactionSettingsProvider>
                </div>
              </>
            )}
          </ImageGuard2>
        </div>
        <div
          className={` @max-md:absolute @max-md:inset-0 ${
            !active ? '@max-md:translate-y-[calc(100%-60px)]' : '@max-md:transition-transform'
          } @md:w-[450px] @md:min-w-[450px] ${
            !sidebarOpen ? '@md:hidden' : ''
          } bg-gray-2 dark:bg-dark-9 flex flex-col z-10`}
        >
          <div className="@md:hidden p-3 @max-md:shadow-topper rounded-md flex justify-between items-center">
            <div className="flex gap-1">{LeftImageControls}</div>
            <ActionIcon {...sharedActionIconProps} onClick={toggleInfo}>
              <IconChevron {...sharedIconProps} />
            </ActionIcon>
          </div>
          <ScrollArea className="p-3 flex-1 @max-md:pt-0">
            <div className="flex flex-col gap-3">
              <SmartCreatorCard
                user={image.user}
                subText={
                  <Text size="xs" color="dimmed">
                    {image.publishedAt ? (
                      <>
                        Uploaded <DaysFromNow date={image.publishedAt} />
                      </>
                    ) : (
                      'Not published'
                    )}
                  </Text>
                }
                tipBuzzEntityId={image.id}
                tipBuzzEntityType="Image"
                className="rounded-xl"
              />
              {image.needsReview && (
                <AlertWithIcon
                  icon={<IconAlertTriangle />}
                  color="yellow"
                  iconColor="yellow"
                  title="Flagged for review"
                  radius={0}
                  px="md"
                >
                  {`This image won't be visible to other users until it's reviewed by our moderators.`}
                </AlertWithIcon>
              )}
              <VotableTags
                entityType="image"
                entityId={image.id}
                canAdd
                collapsible
                nsfwLevel={image.nsfwLevel}
              />
              <Card className="rounded-xl flex flex-col gap-3">
                <Text className="flex items-center gap-2 font-semibold text-xl">
                  <IconBrandWechat />
                  <span>Discussion</span>
                </Text>
                <ImageDetailComments imageId={image.id} userId={image.user.id} />
              </Card>
              <ImageGenerationData imageId={image.id} />
              <ImageProcess imageId={image.id} />
            </div>
          </ScrollArea>
        </div>
      </div>
    </>
  );
}
