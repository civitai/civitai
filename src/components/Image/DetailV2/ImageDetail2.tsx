import {
  ActionIcon,
  ActionIconProps,
  Badge,
  BadgeProps,
  Box,
  Button,
  ButtonProps,
  Card,
  CloseButton,
  createStyles,
  Divider,
  Group,
  MantineProvider,
  Paper,
  ScrollArea,
  Stack,
  Text,
  useMantineTheme,
} from '@mantine/core';
import { Availability, CollectionType } from '@prisma/client';
import {
  IconAlertTriangle,
  IconBookmark,
  IconBrandWechat,
  IconDotsVertical,
  IconEye,
  IconFlag,
  IconForms,
  IconPhoto,
  IconShare3,
  TablerIconsProps,
} from '@tabler/icons-react';
import { adsRegistry } from '~/components/Ads/adsRegistry';
import { Adunit } from '~/components/Ads/AdUnit';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink, triggerRoutedDialog } from '~/components/Dialog/RoutedDialogProvider';
import { ImageDetailCarousel } from '~/components/Image/DetailV2/ImageDetailCarousel';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { ImageDetailContextMenu } from '~/components/Image/Detail/ImageDetailContextMenu';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
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
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ProfileBackgroundCosmetic } from '~/server/selectors/cosmetic.selector';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { ImageResources } from '~/components/Image/DetailV2/ImageResources';
import { LineClamp } from '~/components/LineClamp/LineClamp';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { abbreviateNumber } from '~/utils/number-helpers';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { IconBrush } from '@tabler/icons-react';
import { generationPanel } from '~/store/generation.store';
import { ShareButton } from '~/components/ShareButton/ShareButton';

type SimpleMetaPropsKey = keyof typeof simpleMetaProps;
const simpleMetaProps = {
  cfgScale: 'Guidance',
  steps: 'Steps',
  sampler: 'Sampler',
  seed: 'Seed',
  clipSkip: 'Clip skip',
} as const;

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
  const { query } = useBrowserRouter();

  if (isLoading) return <PageLoader />;
  if (!image) return <NotFound />;

  const nsfw = !getIsSafeBrowsingLevel(image.nsfwLevel);
  const simpleMeta = Object.entries(simpleMetaProps).filter(([key]) => image?.meta?.[key]);
  const hasSimpleMeta = !!simpleMeta.length;

  const handleSaveClick = () =>
    openContext('addToCollection', { imageId: image.id, type: CollectionType.Image });

  const handleReportClick = () => {
    openContext('report', {
      entityType: ReportEntity.Image,
      entityId: image.id,
    });
  };

  const canCreate = !!image.meta?.prompt && !image.hideMeta;

  return (
    <div className="h-full w-full max-w-full max-h-full flex bg-gray-2 dark:bg-dark-9">
      <div className="flex-1 flex flex-col relative ">
        <ImageGuard2 image={image} explain={false}>
          {(safe) => (
            <>
              {/* HEADER */}
              <div className="flex justify-between flex-wrap gap-3 p-3">
                <div className="flex gap-8">
                  <CloseButton onClick={close} variant="filled" className="h-9 w-9 rounded-full" />
                  <div className="flex gap-1">
                    <ImageGuard2.BlurToggle {...sharedBadgeProps} />
                    <Badge {...sharedBadgeProps}>
                      <IconEye {...sharedIconProps} />
                      <Text color="white" size="xs" align="center" weight={500}>
                        {abbreviateNumber(image.stats?.viewCountAllTime ?? 0)}
                      </Text>
                    </Badge>
                    <Button {...sharedButtonProps} onClick={handleSaveClick}>
                      <IconBookmark {...sharedIconProps} />
                      <Text color="white" size="xs" align="center" weight={500}>
                        Save
                      </Text>
                    </Button>
                    {image.postId && (
                      <RoutedDialogLink name="postDetail" state={{ postId: image.postId }}>
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
                  </div>
                </div>
                <div className="flex gap-1">
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
      <ScrollArea className="w-[450px] min-w-[450px] p-3 h-full">
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
          <Card className="rounded-xl flex flex-col gap-3">
            <Text className="flex items-center gap-2 font-semibold text-xl">
              <IconForms />
              <span>Generation data</span>
            </Text>
            <ImageResources imageId={image.id} />
            {image.meta && (
              <>
                {(image.meta.prompt || image.meta.negativePrompt) && <Divider />}
                {image.meta.prompt && (
                  <div className="flex flex-col">
                    <div className="flex justify-between items-center">
                      <Text className="text-lg font-semibold">Prompt</Text>
                    </div>
                    <LineClamp color="dimmed" className="text-sm">
                      {image.meta.prompt}
                    </LineClamp>
                  </div>
                )}
                {image.meta.negativePrompt && (
                  <div className="flex flex-col">
                    <div className="flex justify-between items-center">
                      <Text className="text-md font-semibold">Negative prompt</Text>
                    </div>
                    <LineClamp color="dimmed" className="text-sm">
                      {image.meta.negativePrompt}
                    </LineClamp>
                  </div>
                )}
                {hasSimpleMeta && (
                  <>
                    <Divider />
                    <div className="flex flex-col">
                      <div className="flex justify-between items-center">
                        <Text className="text-lg font-semibold">Other metadata</Text>
                      </div>
                      <div className="flex flex-col">
                        {simpleMeta.map(([key, label]) => (
                          <div key={key} className="flex justify-between">
                            <Text color="dimmed" className="leading-snug">
                              {label}
                            </Text>
                            <Text className="leading-snug">
                              {image.meta?.[key as SimpleMetaPropsKey]}
                            </Text>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
