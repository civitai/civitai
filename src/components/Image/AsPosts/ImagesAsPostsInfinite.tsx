import {
  ActionIcon,
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
  IconArrowsCross,
  IconCloudOff,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconStar,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { PeriodFilter, SortFilter } from '~/components/Filters';
import { ImagesAsPostsCard } from '~/components/Image/AsPosts/ImagesAsPostsCard';
import { useImageFilters } from '~/components/Image/image.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelGenerationCard } from '~/components/Model/Generation/ModelGenerationCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useSetFilters } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { ImageIngestionStatus } from '@prisma/client';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { useEntityAccessRequirement } from '../../Club/club.utils';
import { ResourceAccessWrap } from '../../Access/ResourceAccessWrap';
import { IconSettings } from '@tabler/icons-react';
import { ModelById } from '~/types/router';
import { GalleryModerationModal } from './GalleryModerationModal';
import { useModelGallerySettings } from './gallery.utils';

type ModelVersionsProps = { id: number; name: string; modelId: number };
type ImagesAsPostsInfiniteState = {
  model: ModelById;
  modelVersions?: ModelVersionsProps[];
  filters: {
    modelId?: number;
    username?: string;
  } & Record<string, unknown>;
  showModerationOptions?: boolean;
};
const ImagesAsPostsInfiniteContext = createContext<ImagesAsPostsInfiniteState | null>(null);
export const useImagesAsPostsInfiniteContext = () => {
  const context = useContext(ImagesAsPostsInfiniteContext);
  if (!context) throw new Error('ImagesInfiniteContext not in tree');
  return context;
};

type ImagesAsPostsInfiniteProps = {
  selectedVersionId?: number;
  model: ModelById;
  username?: string;
  modelVersions?: ModelVersionsProps[];
  generationOptions?: { generationModelId?: number; includeEditingActions?: boolean };
  showModerationOptions?: boolean;
};

const LIMIT = 50;
export default function ImagesAsPostsInfinite({
  model,
  username,
  modelVersions,
  selectedVersionId,
  generationOptions,
  showModerationOptions,
}: ImagesAsPostsInfiniteProps) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const isMobile = useContainerSmallerThan('sm');
  // const globalFilters = useImageFilters();
  const [limit] = useState(isMobile ? LIMIT / 2 : LIMIT);
  const [opened, setOpened] = useState(false);
  const [showHidden, setShowHidden] = useState(false);

  const imageFilters = useImageFilters('modelImages');
  const setFilters = useSetFilters('modelImages');
  const filters = removeEmpty({
    ...imageFilters,
    modelVersionId: selectedVersionId,
    modelId: model.id,
    username,
    types: undefined, // override global types image filter
  });

  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching } =
    trpc.image.getImagesAsPostsInfinite.useInfiniteQuery(
      { ...filters, limit },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        trpc: { context: { skipBatch: true } },
        keepPreviousData: true,
        // enabled: inView,
      }
    );

  const {
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: isLoadingHidden,
  } = useHiddenPreferencesContext();

  const {
    hiddenImages: galleryHiddenImages,
    hiddenTags: galleryHiddenTags,
    hiddenUsers: galleryHiddenUsers,
    isLoading: loadingGallerySettings,
  } = useModelGallerySettings({ modelId: model.id });

  const items = useMemo(() => {
    // TODO - fetch user reactions for images separately
    if (isLoadingHidden || loadingGallerySettings) return [];
    const arr = data?.pages.flatMap((x) => x.items) ?? [];
    const filtered = arr
      .filter((x) => {
        if (x.user.id === currentUser?.id) return true;
        if (hiddenUsers.get(x.user.id) || (!showHidden && galleryHiddenUsers.get(x.user.id)))
          return false;
        return true;
      })
      .map(({ images, ...x }) => {
        const filteredImages = images?.filter((i) => {
          // show hidden images only
          if (showHidden) return galleryHiddenImages.get(i.id);

          if (i.ingestion !== ImageIngestionStatus.Scanned) return false;
          if (hiddenImages.get(i.id) || galleryHiddenImages.get(i.id)) return false;
          for (const tag of i.tagIds ?? []) {
            if (hiddenTags.get(tag) || galleryHiddenTags.get(tag)) return false;
          }
          return true;
        });

        if (!filteredImages?.length) return null;

        return {
          ...x,
          images: filteredImages,
        };
      })
      .filter(isDefined);
    return filtered;
  }, [
    data,
    currentUser,
    hiddenImages,
    hiddenTags,
    hiddenUsers,
    isLoadingHidden,
    galleryHiddenImages,
    galleryHiddenTags,
    galleryHiddenUsers,
    loadingGallerySettings,
    showHidden,
  ]);

  useEffect(() => {
    if (galleryHiddenImages.size === 0) setShowHidden(false);
  }, [galleryHiddenImages.size]);

  const isMuted = currentUser?.muted ?? false;
  const addPostLink = `/posts/create?modelId=${model.id}${
    selectedVersionId ? `&modelVersionId=${selectedVersionId}` : ''
  }&returnUrl=${router.asPath}`;
  const { excludeCrossPosts } = imageFilters;
  const hasModerationPreferences =
    galleryHiddenImages.size > 0 || galleryHiddenTags.size > 0 || galleryHiddenUsers.size > 0;

  return (
    <ImagesAsPostsInfiniteContext.Provider
      value={{ filters, modelVersions, showModerationOptions, model }}
    >
      <MasonryProvider columnWidth={310} maxColumnCount={6} maxSingleColumnWidth={450}>
        <MasonryContainer
          fluid
          pt="xl"
          pb={61}
          mb={-61}
          sx={(theme) => ({
            background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
          })}
        >
          <Stack spacing="md">
            <Group spacing="xs">
              <Title order={2}>Gallery</Title>
              {!isMuted && (
                <ResourceAccessWrap
                  entityId={selectedVersionId as number}
                  entityType="ModelVersion"
                >
                  <Group>
                    <LoginRedirect reason="create-review">
                      <Link href={addPostLink}>
                        <Button variant="outline" size="xs" leftIcon={<IconPlus size={16} />}>
                          Add Post
                        </Button>
                      </Link>
                    </LoginRedirect>
                    <LoginRedirect reason="create-review">
                      <Link href={addPostLink + '&reviewing=true'}>
                        <Button leftIcon={<IconStar size={16} />} variant="outline" size="xs">
                          Add Review
                        </Button>
                      </Link>
                    </LoginRedirect>
                  </Group>
                </ResourceAccessWrap>
              )}
              {showModerationOptions && (
                <Group ml="auto" spacing={8}>
                  {galleryHiddenImages.size > 0 && (
                    <ButtonTooltip label={`${showHidden ? 'Hide' : 'Show'} hidden images`}>
                      <ActionIcon
                        variant="outline"
                        color="red"
                        onClick={() => setShowHidden((h) => !h)}
                      >
                        {showHidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
                      </ActionIcon>
                    </ButtonTooltip>
                  )}
                  <ButtonTooltip label="Gallery Moderation Preferences">
                    <ActionIcon variant="outline" onClick={() => setOpened(true)}>
                      <IconSettings size={16} />
                    </ActionIcon>
                  </ButtonTooltip>
                </Group>
              )}
            </Group>
            <Group position="apart" spacing={0}>
              <SortFilter type="modelImages" />
              <Group spacing={4}>
                <PeriodFilter type="modelImages" />
                <ButtonTooltip label={`${excludeCrossPosts ? 'Show' : 'Hide'} Cross-posts`}>
                  <ActionIcon
                    variant={excludeCrossPosts ? 'light' : 'transparent'}
                    color={excludeCrossPosts ? 'red' : undefined}
                    onClick={() => setFilters({ excludeCrossPosts: !excludeCrossPosts })}
                  >
                    <IconArrowsCross size={20} />
                  </ActionIcon>
                </ButtonTooltip>
                {/* <ImageFiltersDropdown /> */}
              </Group>
            </Group>
            {hasModerationPreferences ? (
              <Text size="xs" color="dimmed" mt="-md">
                Some images have been hidden based on moderation preferences set by the creator,{' '}
                <Link href={`/images?modelVersionId=${selectedVersionId}`} passHref>
                  <Anchor span>view all images using this resource</Anchor>
                </Link>
                .
              </Text>
            ) : null}
            {/* <ImageCategories /> */}
            {isLoading ? (
              <Paper style={{ minHeight: 200, position: 'relative' }}>
                <LoadingOverlay visible zIndex={10} />
              </Paper>
            ) : !!items.length ? (
              <div style={{ position: 'relative' }}>
                <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
                <MasonryColumns
                  data={items}
                  staticItem={
                    !!generationOptions?.generationModelId && selectedVersionId
                      ? (props) => (
                          <ModelGenerationCard
                            {...props}
                            versionId={selectedVersionId}
                            modelId={generationOptions.generationModelId}
                            withEditingActions={generationOptions?.includeEditingActions}
                          />
                        )
                      : undefined
                  }
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
                    return imageHeight + 57 + (data.images.length > 1 ? 8 : 0);
                  }}
                  maxItemHeight={600}
                  render={ImagesAsPostsCard}
                  itemId={(data) => data.images.map((x) => x.id).join('_')}
                />
                {hasNextPage && (
                  <InViewLoader
                    loadFn={fetchNextPage}
                    loadCondition={!isRefetching}
                    style={{ gridColumn: '1/-1' }}
                  >
                    <Center p="xl" sx={{ height: 36 }} mt="md">
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
                <Text size={32} align="center">
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

      {/* {isLoading && (
        <Paper style={{ minHeight: 200, position: 'relative' }}>
          <LoadingOverlay visible zIndex={10} />
        </Paper>
      )}
      {!isLoading && !items.length && (
        <Paper p="xl" sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Stack>
            <Text size="xl">There are no images for this model yet.</Text>
            <Text color="dimmed">
              Add a post to showcase your images generated from this model.
            </Text>
          </Stack>
        </Paper>
      )} */}

      <GalleryModerationModal opened={opened} onClose={() => setOpened(false)} />
    </ImagesAsPostsInfiniteContext.Provider>
  );
}
