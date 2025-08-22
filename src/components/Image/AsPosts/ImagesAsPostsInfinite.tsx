import {
  Anchor,
  Button,
  Center,
  Group,
  Loader,
  LoadingOverlay,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconCloudOff,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconSettings,
  IconStar,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SortFilter } from '~/components/Filters';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useGallerySettings } from '~/components/Image/AsPosts/gallery.utils';
import { ImagesAsPostsCard } from '~/components/Image/AsPosts/ImagesAsPostsCard';
import { ImagesAsPostsInfiniteProvider } from '~/components/Image/AsPosts/ImagesAsPostsInfiniteProvider';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { useImageFilters } from '~/components/Image/image.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Flags } from '~/shared/utils/flags';
import type { ModelById } from '~/types/router';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';
import { GalleryModerationModal } from './GalleryModerationModal';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

type ModelVersionsProps = { id: number; name: string; modelId: number };

export type ImagesAsPostsInfiniteProps = {
  selectedVersionId?: number;
  model: ModelById;
  username?: string;
  modelVersions?: ModelVersionsProps[];
  showModerationOptions?: boolean;
  showPOIWarning?: boolean;
  canReview?: boolean;
};

const LIMIT = 50;
export function ImagesAsPostsInfinite({
  model,
  username,
  modelVersions,
  selectedVersionId,
  showModerationOptions,
  showPOIWarning,
  canReview,
}: ImagesAsPostsInfiniteProps) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const isMobile = useContainerSmallerThan('sm');
  const limit = isMobile ? LIMIT / 2 : LIMIT;

  const [showHidden, setShowHidden] = useState(false);

  const imageFilters = useImageFilters('modelImages');
  const filters = removeEmpty({
    ...imageFilters,
    modelVersionId: selectedVersionId,
    modelId: model.id,
    username,
    hidden: showHidden, // override global hidden filter
    // types: [MediaType.image, MediaType.video], // override global types image filter
  });

  const browsingLevel = useBrowsingLevelDebounced();
  const { gallerySettings } = useGallerySettings({ modelId: model.id });
  let intersection = browsingLevel;
  if (gallerySettings?.level) {
    intersection = Flags.intersection(browsingLevel, gallerySettings.level);
  }
  const enabled = !!gallerySettings && intersection > 0;
  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    trpc.image.getImagesAsPostsInfinite.useInfiniteQuery(
      { ...filters, limit, browsingLevel: intersection },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        trpc: { context: { skipBatch: true } },
        keepPreviousData: true,
        enabled,
        // enabled: inView,
      }
    );

  const hiddenUsers = useMemo(
    () => gallerySettings?.hiddenUsers.map((x) => x.id),
    [gallerySettings?.hiddenUsers]
  );
  const hiddenTags = useMemo(
    () => gallerySettings?.hiddenTags.map((x) => x.id),
    [gallerySettings?.hiddenTags]
  );

  const hiddenImageIds = useMemo(
    () =>
      selectedVersionId && gallerySettings
        ? gallerySettings.hiddenImages?.[selectedVersionId] ?? []
        : [],
    [selectedVersionId, gallerySettings]
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items } = useApplyHiddenPreferences({
    type: 'posts',
    data: flatData,
    hiddenImages: !showHidden ? hiddenImageIds : undefined,
    hiddenUsers: !showHidden ? hiddenUsers : undefined,
    hiddenTags: !showHidden ? hiddenTags : undefined,
    browsingLevel: intersection,
  });

  const handleAddPostClick = (opts?: { reviewing?: boolean }) => {
    const queryString = QS.stringify({
      modelId: model.id,
      modelVersionId: selectedVersionId,
      returnUrl: router.asPath,
      reviewing: opts?.reviewing,
    });

    router.push(`/posts/create?${queryString}`);
  };

  useEffect(() => {
    if (!hiddenImageIds.length) setShowHidden(false);
  }, [hiddenImageIds]);

  const isMuted = currentUser?.muted ?? false;
  const hasModerationPreferences =
    !!hiddenImageIds.length ||
    !!gallerySettings?.hiddenUsers.length ||
    !!gallerySettings?.hiddenTags.length;

  return (
    <ImagesAsPostsInfiniteProvider value={{ filters, modelVersions, showModerationOptions, model }}>
      <MasonryProvider
        columnWidth={320}
        maxColumnCount={6}
        maxSingleColumnWidth={450}
        style={{ flex: 1 }}
      >
        <MasonryContainer>
          <Stack gap="md">
            <Group gap="xs">
              <Title order={2} data-tour="model:gallery">
                Gallery
              </Title>
              {!isMuted && (
                <Group>
                  <LoginRedirect reason="post-images">
                    <Button
                      variant="outline"
                      size="xs"
                      leftSection={<IconPlus size={16} />}
                      onClick={() => handleAddPostClick()}
                    >
                      Add Post
                    </Button>
                  </LoginRedirect>
                  {canReview && (
                    <LoginRedirect reason="create-review">
                      <Button
                        leftSection={<IconStar size={16} />}
                        variant="outline"
                        size="xs"
                        onClick={() => handleAddPostClick({ reviewing: true })}
                      >
                        Add Review
                      </Button>
                    </LoginRedirect>
                  )}
                </Group>
              )}
              <Group ml="auto" gap={8}>
                <SortFilter type="modelImages" />
                <MediaFiltersDropdown filterType="modelImages" size="compact-sm" hideBaseModels />
                {showModerationOptions && (
                  <>
                    {!!hiddenImageIds.length && (
                      <ButtonTooltip label={`${showHidden ? 'Hide' : 'Show'} hidden images`}>
                        <LegacyActionIcon
                          variant="light"
                          radius="xl"
                          color="red"
                          onClick={() => setShowHidden((h) => !h)}
                        >
                          {showHidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
                        </LegacyActionIcon>
                      </ButtonTooltip>
                    )}
                    <ButtonTooltip label="Gallery Moderation Preferences">
                      <LegacyActionIcon
                        variant="filled"
                        radius="xl"
                        onClick={() =>
                          dialogStore.trigger({
                            component: GalleryModerationModal,
                            props: { modelId: model.id },
                          })
                        }
                      >
                        <IconSettings size={16} />
                      </LegacyActionIcon>
                    </ButtonTooltip>
                  </>
                )}
              </Group>
            </Group>
            {showPOIWarning && (
              <Text size="sm" c="dimmed" lh={1.1}>
                This resource is intended to depict a real person. All images that use this resource
                are scanned for mature themes and manually reviewed by a moderator in accordance
                with our{' '}
                <Text component={Link} href="/content/rules/real-people" td="underline">
                  real person policy
                </Text>
                .{' '}
                <Text td="underline" component="span">
                  If you see an image that violates this policy, please report it immediately.
                </Text>
              </Text>
            )}
            {hasModerationPreferences && selectedVersionId ? (
              <Text size="xs" c="dimmed" mt="-md">
                Some images have been hidden based on moderation preferences set by the creator,{' '}
                <Link legacyBehavior href={`/images?modelVersionId=${selectedVersionId}`} passHref>
                  <Anchor inherit span>
                    view all images using this resource
                  </Anchor>
                </Link>
                .
              </Text>
            ) : null}
            <ImageCategories />
            {enabled && isLoading ? (
              <Paper style={{ minHeight: 200, position: 'relative' }}>
                <LoadingOverlay visible zIndex={10} />
              </Paper>
            ) : !!items.length ? (
              <div style={{ position: 'relative' }}>
                <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
                <MasonryColumnsVirtual
                  data={items}
                  imageDimensions={(data) => {
                    const tallestImage = data.images.sort((a, b) => {
                      const aHeight = a.height ?? 0;
                      const bHeight = b.height ?? 0;
                      const aAspectRatio = aHeight > 0 ? (a.width ?? 0) / aHeight : 0;
                      const bAspectRatio = bHeight > 0 ? (b.width ?? 0) / bHeight : 0;
                      if (aAspectRatio < 1 && bAspectRatio >= 1) return -1;
                      if (bAspectRatio < 1 && aAspectRatio <= 1) return 1;
                      if (aHeight === bHeight) return 0;
                      return aHeight > bHeight ? -1 : 1;
                    })[0];

                    const width = tallestImage?.width ?? 450;
                    const height = tallestImage?.height ?? 450;
                    return { width, height };
                  }}
                  adjustHeight={({ height }, data) => {
                    const imageHeight = Math.min(height, 600);
                    return (
                      imageHeight +
                      (data.user.id !== -1 ? 58 : 0) +
                      (data.images.length > 1 ? 8 : 0)
                    );
                  }}
                  maxItemHeight={600}
                  render={ImagesAsPostsCard}
                  itemId={(data) => data.images.map((x) => x.id).join('_')}
                  withAds
                />
                {hasNextPage && (
                  <InViewLoader
                    loadFn={fetchNextPage}
                    loadCondition={!isFetching}
                    style={{ gridColumn: '1/-1' }}
                  >
                    <Center p="xl" style={{ height: 36 }} mt="md">
                      <Loader />
                    </Center>
                  </InViewLoader>
                )}
              </div>
            ) : (
              <Stack align="center" py="lg">
                <ThemeIcon size={128} radius={100}>
                  <IconCloudOff size={80} />
                </ThemeIcon>
                <Text fz={32} align="center">
                  No results found
                </Text>
                <Text align="center">
                  {"Try adjusting your search or filters to find what you're looking for"}
                </Text>
              </Stack>
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </ImagesAsPostsInfiniteProvider>
  );
}
