import type { ThemeIconProps } from '@mantine/core';
import {
  Badge,
  Center,
  getPrimaryShade,
  HoverCard,
  Loader,
  Paper,
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
import { memo, useCallback, useMemo, useState } from 'react';
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
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { isDefined } from '~/utils/type-guards';
import { SimpleImageCarousel } from '~/components/SimpleImageCarousel/SimpleImageCarousel';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { mergePostImages, shouldFetchPostTail } from '~/components/Image/AsPosts/lazyPostImages';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';
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
const edgeMediaWrapperProps = { style: { zIndex: 1 } };

function ImagesAsPostsCardNoMemo(props: ImagesAsPostsCardProps) {
  const { data, height } = props;
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const { source, filters } = useImagesAsPostsInfiniteContext();
  const currentModelVersionId = filters.modelVersionId as number;
  const image = data.images[0];
  // Pinned-post highlighting only exists on Model galleries (mods pin posts
  // per Model version). Pass `undefined` to disable the query when this
  // gallery is bound to a non-Model entity.
  const { gallerySettings } = useGallerySettings({
    modelId: source.kind === 'model' ? source.model.id : undefined,
  });
  const pinned = gallerySettings
    ? gallerySettings.pinnedPosts?.[currentModelVersionId]?.includes(data.postId)
    : false;
  const cosmetic = useMemo(
    () => data.images.find((i) => isDefined(i.cosmetic))?.cosmetic,
    [data.images]
  );
  const cosmeticData = useMemo(() => {
    if (!cosmetic?.data && !pinned) return undefined;
    return {
      ...cosmetic?.data,
      ...(pinned
        ? {
            border: theme.colors.orange[getPrimaryShade(theme, colorScheme)],
            borderWidth: 2,
          }
        : undefined),
    };
  }, [cosmetic?.data, pinned, theme, colorScheme]);

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
          {data.user.id !== -1 && <ImagesAsPostsCardHeader {...props} cosmetic={cosmetic} />}

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

function ImagesAsPostsCardHeader({
  data,
  cosmetic,
}: ImagesAsPostsCardProps & { cosmetic?: ImagesAsPostModel['images'][number]['cosmetic'] }) {
  const { modelVersions, source, filters } = useImagesAsPostsInfiniteContext();
  const targetModelVersion = modelVersions?.find((x) => x.id === data.modelVersionId);
  const currentModelVersionId = filters.modelVersionId as number;
  // Single pass: find both auto-resource and manual-resource matches
  let fromAutoResource = false;
  let fromManualResource = false;
  if (!targetModelVersion) {
    for (const i of data.images) {
      if (!fromAutoResource && i.modelVersionIds?.includes(currentModelVersionId)) {
        fromAutoResource = true;
      }
      if (!fromManualResource && i.modelVersionIdsManual?.includes(currentModelVersionId)) {
        fromManualResource = true;
      }
      if (fromAutoResource && fromManualResource) break;
    }
  }
  const isThumbsUp = !!data.review?.recommended;
  // The "OP" badge marks the post author as the entity's creator. Both
  // Model and Model3D galleries surface this — the source union narrows
  // to the right userId.
  const creatorUserId =
    source.kind === 'model' ? source.model.user.id : source.creatorUserId;
  const isOP = data.user.id === creatorUserId;

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
          <div className="flex flex-nowrap items-center gap-2.5">
            {data.publishedAt || data.sortAt ? (
              <DaysFromNow date={data.publishedAt || data.sortAt} />
            ) : (
              <Text>Not published</Text>
            )}
            {(fromAutoResource || fromManualResource) && (
              <div className="ml-1.5 flex items-center gap-1">
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
              </div>
            )}
          </div>
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
              <div className="flex flex-nowrap items-center gap-1">
                {isThumbsUp ? <ThumbsUpIcon filled /> : <ThumbsDownIcon filled />}
                {data.review.details && <IconMessage size={18} strokeWidth={2.5} />}
              </div>
            </Badge>
          </RoutedDialogLink>
        ) : null}
      </div>
    </Paper>
  );
}

function ImagesAsPostsCardContent({ data }: { data: ImagesAsPostModel }) {
  const features = useFeatureFlags();
  const { trackAction } = useTrackEvent();
  const postId = data.postId ?? undefined;
  const image = data.images[0];
  // Not wrapping in useCallback: the returned inner closure captures
  // `selectedImage` and is recreated per call regardless, so the outer
  // `useCallback` would provide no stability benefit.
  const handleRemixClick = (selectedImage: typeof image) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    trackAction({
      type: 'Image_Remix_Click',
      details: {
        imageId: selectedImage.id,
        imageType: selectedImage.type,
        source: 'remix:model-gallery',
      },
    }).catch(() => undefined);
    generationGraphPanel.open({
      type: selectedImage.type,
      id: selectedImage.id,
    });
  };

  return data.images.length === 1 ? (
    <ImageGuard2 image={image}>
      {(safe) => (
        <>
          {image.onSite && <OnsiteIndicator isRemix={!!image.remixOfId} />}
          <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
          {safe && (
            <div className="absolute right-2 top-2 z-10 flex flex-col gap-2">
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
            </div>
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
                  imageId={image.id}
                  width={450}
                  placeholder="empty"
                  wrapperProps={edgeMediaWrapperProps}
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
            <div className="absolute bottom-1 right-0.5 z-10">
              <ImageMetaPopover2 imageId={image.id} type={image.type}>
                <div className="m-0.5 flex size-7 items-center justify-center rounded-full bg-black/50">
                  <IconInfoCircle color="white" opacity={0.9} strokeWidth={2.5} size={20} />
                </div>
              </ImageMetaPopover2>
            </div>
          )}
        </>
      )}
    </ImageGuard2>
  ) : features.galleryLazyPostImages &&
    data.imageCount != null &&
    data.imageCount > data.images.length ? (
    // LAZY: server sent a first slice + the true `imageCount`; load the tail on
    // approach so the initial feed payload stays small without truncating the UX.
    <LazyPostImagesCarousel data={data} postId={postId} />
  ) : (
    // Today's behaviour (flag OFF, or a post already within the slice): all images
    // are inline — render them directly, no lazy fetch.
    <StaticPostImagesCarousel images={data.images} postId={postId} />
  );
}

const carouselIndicatorProps = {
  className: 'flex w-full gap-px',
  indicatorClassName:
    'h-2 flex-1 bg-white opacity-60 shadow-sm data-[active]:opacity-100',
} as const;

/**
 * One carousel slide's content (blur guard, remix, image, reactions, meta). Shared
 * by the static and lazy carousels so an appended (lazily-fetched) image renders
 * byte-identically to a seeded one. `dialogImages` seeds the detail modal with the
 * carousel's currently-loaded set.
 */
function PostCarouselSlide({
  image,
  postId,
  dialogImages,
}: {
  image: ImagesAsPostModel['images'][number];
  postId: number;
  dialogImages: ImagesAsPostModel['images'];
}) {
  const features = useFeatureFlags();
  const { trackAction } = useTrackEvent();
  const handleRemixClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    trackAction({
      type: 'Image_Remix_Click',
      details: { imageId: image.id, imageType: image.type, source: 'remix:model-gallery' },
    }).catch(() => undefined);
    generationGraphPanel.open({ type: image.type, id: image.id });
  };

  return (
    <ImageGuard2 image={image} connectType="post" connectId={postId}>
      {(safe) => (
        <>
          {image.onSite && <OnsiteIndicator isRemix={!!image.remixOfId} />}
          <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
          {safe && (
            <div className="absolute right-2 top-2 z-10 flex flex-col gap-2">
              <ImagesAsPostsContextMenu image={image} />
              {features.imageGeneration && (image.hasPositivePrompt ?? image.hasMeta) && (
                <HoverActionButton
                  label="Remix"
                  size={30}
                  color="white"
                  variant="filled"
                  data-activity="remix:model-gallery"
                  onClick={handleRemixClick}
                >
                  <IconBrush stroke={2.5} size={16} />
                </HoverActionButton>
              )}
            </div>
          )}
          <RoutedDialogLink
            name="imageDetail"
            state={{ imageId: image.id }}
            getState={() => ({ imageId: image.id, images: dialogImages })}
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
                  imageId={image.id}
                  width={450}
                  placeholder="empty"
                  wrapperProps={edgeMediaWrapperProps}
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
            <div className="absolute bottom-1 right-0.5 z-10">
              <ImageMetaPopover2 imageId={image.id} type={image.type}>
                <div className="m-0.5 flex size-7 items-center justify-center rounded-full bg-black/50">
                  <IconInfoCircle color="white" opacity={0.9} strokeWidth={2.5} size={20} />
                </div>
              </ImageMetaPopover2>
            </div>
          )}
        </>
      )}
    </ImageGuard2>
  );
}

/** Today's carousel: every image is already in hand. Exported for component tests. */
export function StaticPostImagesCarousel({
  images,
  postId,
}: {
  images: ImagesAsPostModel['images'];
  postId: number;
}) {
  return (
    <SimpleImageCarousel loop total={images.length} className="flex h-full flex-col">
      <SimpleImageCarousel.Viewport className="relative flex-1">
        <SimpleImageCarousel.Container className="h-full">
          {images.map((image, index) => (
            <SimpleImageCarousel.Slide key={index} index={index} className="relative">
              <PostCarouselSlide image={image} postId={postId} dialogImages={images} />
            </SimpleImageCarousel.Slide>
          ))}
        </SimpleImageCarousel.Container>
        <SimpleImageCarousel.Controls />
      </SimpleImageCarousel.Viewport>
      <SimpleImageCarousel.Indicators {...carouselIndicatorProps} />
    </SimpleImageCarousel>
  );
}

/**
 * Lazy carousel: seeded with the first slice + the true `imageCount`. Shows "1 of
 * N" immediately (indicators from `imageCount`); fetches the post's remaining
 * images via `trpc.image.getInfinite({ postId })` when the active slide approaches
 * the loaded edge, re-applies the feed's hidden preferences to the fetched tail
 * (content safety), and appends. The detail modal is seeded with whatever is
 * loaded at click time.
 *
 * Exported for component tests.
 */
export function LazyPostImagesCarousel({
  data,
  postId,
}: {
  data: ImagesAsPostModel;
  postId: number;
}) {
  const { filters, browsingLevel, hiddenImageIds, hiddenTags, hiddenUsers } =
    useImagesAsPostsInfiniteContext();
  const seed = data.images;
  const total = data.imageCount ?? seed.length;

  // Latch: fire the tail fetch once, when the active slide nears the loaded edge.
  const [fetchTail, setFetchTail] = useState(false);
  const handleIndexChange = useCallback(
    (index: number) => {
      setFetchTail(
        (prev) =>
          prev ||
          shouldFetchPostTail({ currentIndex: index, loadedCount: seed.length, total })
      );
    },
    [seed.length, total]
  );

  // The tail = the WHOLE post (≤ POST_IMAGE_LIMIT), same version/browsing-level
  // filters the gallery used, so the returned set matches `imageCount`. postId
  // forces the DB path server-side (covered index, ~2ms).
  const { data: tailData, isError: tailError } = trpc.image.getInfinite.useQuery(
    {
      ...filters,
      postId,
      browsingLevel,
      limit: POST_IMAGE_LIMIT,
      include: ['cosmetics', 'tagIds'],
    },
    {
      // `postId != null` is the explicit invariant: a null postId must never broaden
      // `getInfinite` to the model's general feed (it would append unrelated images).
      enabled: fetchTail && postId != null,
      trpc: { context: { skipBatch: true } },
      staleTime: 5 * 60 * 1000,
    }
  );

  // Content safety: re-apply the feed's hidden preferences to the fetched tail so
  // it never surfaces images the feed slice would have dropped (owner/user-hidden,
  // system-hidden tags, poi/minor). Browsing level is already applied server-side.
  const { items: filteredTail } = useApplyHiddenPreferences({
    type: 'images',
    data: tailData?.items,
    hiddenImages: hiddenImageIds,
    hiddenUsers,
    hiddenTags,
    browsingLevel,
  });

  const fetched = !!tailData;
  const loaded = useMemo(
    () =>
      fetched
        ? (mergePostImages(
            seed as { id: number }[],
            (filteredTail ?? []) as { id: number }[]
          ) as ImagesAsPostModel['images'])
        : seed,
    [fetched, seed, filteredTail]
  );

  // Before the tail resolves, advertise the true count so indicators read "1 of N".
  // After, use the actual loaded length so navigation never dead-ends if the tail
  // came back short (a hidden-pref drop) — self-correcting.
  //
  // On a persistent tail-fetch ERROR the tail never arrives (`fetched` stays false),
  // so fall back to `loaded.length` (the seed) too — otherwise `effectiveTotal` would
  // stay at the true count while `loaded` holds only the seed, stranding the unloaded
  // slots on an unreachable `<Loader/>` at a dead-end "1 of N". Degrade only on error;
  // the normal in-flight case keeps the true count so the loaders show while fetching.
  const effectiveTotal = fetched || tailError ? loaded.length : total;

  return (
    <SimpleImageCarousel
      loop
      total={effectiveTotal}
      onIndexChange={handleIndexChange}
      className="flex h-full flex-col"
    >
      <SimpleImageCarousel.Viewport className="relative flex-1">
        <SimpleImageCarousel.Container className="h-full">
          {Array.from({ length: effectiveTotal }).map((_, index) => (
            <SimpleImageCarousel.Slide key={index} index={index} className="relative">
              {loaded[index] ? (
                <PostCarouselSlide image={loaded[index]} postId={postId} dialogImages={loaded} />
              ) : (
                <Center className="size-full">
                  <Loader />
                </Center>
              )}
            </SimpleImageCarousel.Slide>
          ))}
        </SimpleImageCarousel.Container>
        <SimpleImageCarousel.Controls />
      </SimpleImageCarousel.Viewport>
      <SimpleImageCarousel.Indicators {...carouselIndicatorProps} />
    </SimpleImageCarousel>
  );
}
