import type { ThemeIconProps } from '@mantine/core';
import {
  Badge,
  getPrimaryShade,
  Group,
  HoverCard,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import type { IconProps } from '@tabler/icons-react';
import {
  IconAutomaticGearbox,
  IconBrush,
  IconExclamationMark,
  IconInfoCircle,
  IconMessage,
  IconPinFilled,
  IconUserPlus,
} from '@tabler/icons-react';
import { useCallback, memo } from 'react';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { useGallerySettings } from '~/components/Image/AsPosts/gallery.utils';
import { useImagesAsPostsInfiniteContext } from '~/components/Image/AsPosts/ImagesAsPostsInfiniteProvider';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Reactions } from '~/components/Reaction/Reactions';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { TwCard } from '~/components/TwCard/TwCard';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ImagesAsPostModel } from '~/server/controllers/image.controller';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { isDefined } from '~/utils/type-guards';
import { SimpleImageCarousel } from '~/components/SimpleImageCarousel/SimpleImageCarousel';
import classes from './ImagesAsPostsCard.module.css';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ImagesAsPostsContextMenu } from '~/components/Image/ContextMenu/ImagesAsPostsContextMenu';

type ImagesAsPostsCardProps = {
  data: ImagesAsPostModel;
  width: number;
  height: number;
};

const pinnedIconProps = { size: 16, stroke: 1.5 };

function ImagesAsPostsCardNoMemo(props: ImagesAsPostsCardProps) {
  const { data, height } = props;
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { model, filters } = useImagesAsPostsInfiniteContext();
  const currentModelVersionId = filters.modelVersionId as number;
  const image = data.images[0];
  const { gallerySettings } = useGallerySettings({ modelId: model.id });
  const pinned = gallerySettings
    ? gallerySettings.pinnedPosts?.[currentModelVersionId]?.includes(data.postId)
    : false;
  const cosmetic = data.images.find((i) => isDefined(i.cosmetic))?.cosmetic;
  const cosmeticData =
    cosmetic?.data || pinned
      ? {
          ...cosmetic?.data,
          ...(pinned
            ? {
                border: theme.colors.orange[getPrimaryShade(theme, colorScheme)],
                borderWidth: 2,
              }
            : undefined),
        }
      : undefined;

  return (
    <TwCosmeticWrapper
      className="w-full"
      cosmetic={cosmeticData}
      style={cosmeticData ? { height } : undefined}
    >
      <>
        {pinned && (
          <PinnedIndicator radius="xl" color="orange" size="md" iconProps={pinnedIconProps} />
        )}
        <TwCard
          style={!cosmeticData ? { height } : undefined}
          className={clsx({ ['border']: !pinned })}
        >
          <MediaHash {...image} className={clsx('opacity-70', cosmetic && 'rounded-b-lg')} />
          {data.user.id !== -1 && <ImagesAsPostsCardHeader {...props} />}

          <div className="relative flex-1 overflow-hidden">
            <ImagesAsPostsCardContent data={props.data} />
          </div>
        </TwCard>
      </>
    </TwCosmeticWrapper>
  );
}
export const ImagesAsPostsCard = memo(ImagesAsPostsCardNoMemo);

function PinnedIndicator({
  iconProps,
  className,
  ...themeIconProps
}: Omit<ThemeIconProps, 'children'> & { iconProps?: IconProps }) {
  return (
    <HoverCard width={300} withArrow withinPortal>
      <HoverCard.Target>
        <ThemeIcon {...themeIconProps} className="absolute -right-2.5 -top-2.5 z-10">
          <IconPinFilled {...iconProps} />
        </ThemeIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown px="md" py={8}>
        <Text size="sm" fw={600}>
          Pinned Post
        </Text>
        <Text size="xs">
          The creator of this post has pinned this because it is an excellent showcase of the
          resource&apos;s ability
        </Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function ImagesAsPostsCardHeader({ data }: ImagesAsPostsCardProps) {
  const { modelVersions, model, filters } = useImagesAsPostsInfiniteContext();
  const targetModelVersion = modelVersions?.find((x) => x.id === data.modelVersionId);
  const currentModelVersionId = filters.modelVersionId as number;
  const fromAutoResource =
    !targetModelVersion &&
    data.images.some((i) => i.modelVersionIds?.includes(currentModelVersionId));
  const fromManualResource =
    !targetModelVersion &&
    data.images.some((i) => i.modelVersionIdsManual?.includes(currentModelVersionId));
  const isThumbsUp = !!data.review?.recommended;
  const isOP = data.user.id === model?.user.id;
  const cosmetic = data.images.find((i) => isDefined(i.cosmetic))?.cosmetic;

  return (
    <Paper
      p="xs"
      radius={0}
      className={clsx(
        'z-[2] flex h-[58px] items-start justify-between gap-2',
        cosmetic && 'rounded-t-lg '
      )}
    >
      <UserAvatar
        user={data.user}
        subText={
          <Group gap="xs" wrap="nowrap">
            {data.publishedAt || data.sortAt ? (
              <DaysFromNow date={data.publishedAt || data.sortAt} />
            ) : (
              <Text>Not published</Text>
            )}
            {(fromAutoResource || fromManualResource) && (
              <Group ml={6} gap={4}>
                {fromAutoResource && (
                  <Tooltip label="Auto-detected resource" withArrow>
                    <ThemeIcon color="teal" variant="light" radius="xl" size={18}>
                      <IconAutomaticGearbox size={16} />
                    </ThemeIcon>
                  </Tooltip>
                )}
                {fromManualResource && (
                  <Tooltip label="Manually-added resource" withArrow>
                    <ThemeIcon color="cyan" variant="light" radius="xl" size={18}>
                      <IconUserPlus size={16} />
                    </ThemeIcon>
                  </Tooltip>
                )}
              </Group>
            )}
          </Group>
        }
        subTextForce
        size="md"
        spacing="xs"
        badge={
          isOP ? (
            <Badge size="xs" color="violet" radius="xl">
              OP
            </Badge>
          ) : null
        }
        withUsername
        linkToProfile
      />
      <div className="flex justify-end gap-2">
        {!data.publishedAt && (
          <Tooltip label="Post not Published" withArrow>
            <Link href={`/posts/${data.postId}/edit`}>
              <LegacyActionIcon color="red" variant="outline">
                <IconExclamationMark />
              </LegacyActionIcon>
            </Link>
          </Tooltip>
        )}
        {data.review ? (
          <RoutedDialogLink name="resourceReview" state={{ reviewId: data.review.id }}>
            <Badge
              variant="light"
              radius="md"
              size="lg"
              style={{
                userSelect: 'none',
                padding: 4,
                height: 'auto',
                cursor: 'pointer',
              }}
              color={isThumbsUp ? 'success.5' : 'red'}
            >
              <Group gap={4} wrap="nowrap">
                {isThumbsUp ? <ThumbsUpIcon filled /> : <ThumbsDownIcon filled />}
                {data.review.details && <IconMessage size={18} strokeWidth={2.5} />}
              </Group>
            </Badge>
          </RoutedDialogLink>
        ) : null}
      </div>
    </Paper>
  );
}

function ImagesAsPostsCardContent({ data }: { data: ImagesAsPostModel }) {
  const features = useFeatureFlags();
  const postId = data.postId ?? undefined;
  const image = data.images[0];
  const handleRemixClick = useCallback(
    (selectedImage: typeof image) => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      generationGraphPanel.open({
        type: selectedImage.type,
        id: selectedImage.id,
      });
    },
    []
  );

  return data.images.length === 1 ? (
    <ImageGuard2 image={image}>
      {(safe) => (
        <>
          {image.onSite && <OnsiteIndicator isRemix={!!image.remixOfId} />}
          <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
          {safe && (
            <Stack gap="xs" className="absolute right-2 top-2 z-10">
              <ImagesAsPostsContextMenu image={image} />
              {features.imageGeneration && (image.hasPositivePrompt ?? image.hasMeta) && (
                <HoverActionButton
                  label="Remix"
                  size={30}
                  color="white"
                  variant="filled"
                  data-activity="remix:model-gallery"
                  onClick={handleRemixClick(image)}
                >
                  <IconBrush stroke={2.5} size={16} />
                </HoverActionButton>
              )}
            </Stack>
          )}
          <RoutedDialogLink
            name="imageDetail"
            state={{ imageId: image.id, images: [image] }}
            className={classes.link}
          >
            <>
              {safe && (
                <EdgeMedia2
                  metadata={image.metadata}
                  src={image.url}
                  thumbnailUrl={image.thumbnailUrl}
                  name={image.name ?? image.id.toString()}
                  alt={image.name ?? undefined}
                  type={image.type}
                  width={450}
                  placeholder="empty"
                  wrapperProps={{ style: { zIndex: 1 } }}
                  skip={getSkipValue(image)}
                  // fadeIn
                  className="z-[1] object-cover"
                />
              )}
            </>
          </RoutedDialogLink>

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
            targetUserId={image.user.id}
            disableBuzzTip={image.poi}
          />
          {image.hasMeta && (
            <div className="absolute bottom-0.5 right-0.5 z-10">
              <ImageMetaPopover2 imageId={image.id} type={image.type}>
                <LegacyActionIcon component="div" variant="transparent" size="lg">
                  <IconInfoCircle
                    color="white"
                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                    opacity={0.8}
                    strokeWidth={2.5}
                    size={26}
                  />
                </LegacyActionIcon>
              </ImageMetaPopover2>
            </div>
          )}
        </>
      )}
    </ImageGuard2>
  ) : (
    <SimpleImageCarousel loop total={data.images.length} className="flex h-full flex-col">
      <SimpleImageCarousel.Viewport className="relative flex-1">
        <SimpleImageCarousel.Container className="h-full">
          {data.images.map((image, index) => (
            <SimpleImageCarousel.Slide key={index} index={index} className="relative">
              <ImageGuard2 image={image} connectType="post" connectId={postId}>
                {(safe) => (
                  <>
                    {image.onSite && <OnsiteIndicator isRemix={!!image.remixOfId} />}
                    <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                    {safe && (
                      <Stack gap="xs" className="absolute right-2 top-2 z-10">
                        <ImagesAsPostsContextMenu image={image} />
                        {features.imageGeneration && (image.hasPositivePrompt ?? image.hasMeta) && (
                          <HoverActionButton
                            label="Remix"
                            size={30}
                            color="white"
                            variant="filled"
                            data-activity="remix:model-gallery"
                            onClick={handleRemixClick(image)}
                          >
                            <IconBrush stroke={2.5} size={16} />
                          </HoverActionButton>
                        )}
                      </Stack>
                    )}
                    <RoutedDialogLink
                      name="imageDetail"
                      state={{ imageId: image.id, images: data.images }}
                      className={classes.link}
                    >
                      <>
                        <MediaHash {...image} className="opacity-70" />

                        {safe && (
                          <EdgeMedia2
                            metadata={image.metadata}
                            src={image.url}
                            thumbnailUrl={image.thumbnailUrl}
                            name={image.name ?? image.id.toString()}
                            alt={image.name ?? undefined}
                            type={image.type}
                            width={450}
                            placeholder="empty"
                            wrapperProps={{ style: { zIndex: 1 } }}
                            skip={getSkipValue(image)}
                            className="z-[1] object-cover"
                          />
                        )}
                      </>
                    </RoutedDialogLink>
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
                      targetUserId={image.user.id}
                      disableBuzzTip={image.poi}
                    />
                    {image.hasMeta && (
                      <div className="absolute bottom-0.5 right-0.5 z-10">
                        <ImageMetaPopover2 imageId={image.id} type={image.type}>
                          <LegacyActionIcon component="div" variant="transparent" size="lg">
                            <IconInfoCircle
                              color="white"
                              filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                              opacity={0.8}
                              strokeWidth={2.5}
                              size={26}
                            />
                          </LegacyActionIcon>
                        </ImageMetaPopover2>
                      </div>
                    )}
                  </>
                )}
              </ImageGuard2>
            </SimpleImageCarousel.Slide>
          ))}
        </SimpleImageCarousel.Container>
        <SimpleImageCarousel.Controls />
      </SimpleImageCarousel.Viewport>
      <SimpleImageCarousel.Indicators
        className="flex w-full gap-px"
        indicatorClassName="h-2 flex-1 bg-white opacity-60 shadow-sm data-[active]:opacity-100"
      />
    </SimpleImageCarousel>
  );
}
