import {
  Anchor,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useEffect } from 'react';
import { NextLink } from '~/components/NextLink/NextLink';
import { useInstantSearch } from 'react-instantsearch';
import {
  BrowsingLevelFilter,
  DateRangeRefinement,
  SearchableMultiSelectRefinementList,
} from '~/components/Search/CustomSearchComponents';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { SearchLayout } from '~/components/Search/SearchLayout';
import { IconCloudOff, IconPhotoSearch } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { resolveTags } from '~/server/services/semantic-search-client';
import { imageFeedUrlFromLegacySearch } from '~/components/Image/Infinite/image-feed-search';
import { legacyImageSearchDestination } from '~/components/Search/search-target';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ImagesCardMemoized } from '~/components/Image/Infinite/ImagesCard';
import { adjustImagesCardHeight } from '~/components/Image/Infinite/images-card-footer';
import { useSearchEventDecorations } from '~/components/Decorations/useSearchEventDecorations';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { useSimilarImage } from '~/components/Search/useSimilarImage';
import { useScrollToTopOnChange } from '~/hooks/useScrollToTopOnChange';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { renderBaseModelOption } from '~/components/SfwOnlyBadge/SfwOnlyBadge';
import { SEARCH_FACET_LIMIT } from '~/shared/constants/search.constants';

import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
export default function ImageSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Content>
        <SearchHeader />
        <ImagesHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

function RenderFilters() {
  // Sort, media type, aspect ratio, tools and techniques return when the image index carries
  // what they need (docs/image-search-qdrant-plan.md).
  return (
    <div className="flex flex-col gap-4 pt-4 [&_.mantine-Accordion-control]:pt-2 [&_.mantine-Accordion-panel]:pb-1">
      <Text size="sm" c="dimmed" className="px-4 pb-2">
        Filters narrow down a search. Type what you&rsquo;re looking for in the search bar first.
      </Text>
      <BrowsingLevelFilter indexKey="images" />
      <DateRangeRefinement title="Filter by Posted Date" attribute="createdAtUnix" />
      <SearchableMultiSelectRefinementList title="Users" attribute="user.username" searchable />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tagNames"
        operator="and"
        searchable
      />
      <SearchableMultiSelectRefinementList
        title="Filter by Base Model"
        sortBy={['name']}
        attribute="baseModel"
        limit={SEARCH_FACET_LIMIT}
        searchable
        remoteSearch={false}
        renderOption={renderBaseModelOption}
      />
    </div>
  );
}

function ImagesHitList() {
  const { status, indexUiState, results } = useInstantSearch();
  const correctedQuery = (results?.userData as { correctedQuery?: string }[] | undefined)?.[0]
    ?.correctedQuery;

  const { hits, showMore, isLastPage } = useInfiniteHitsTransformed<'images'>();

  const { loadingPreferences, items, hiddenCount } = useApplyHiddenPreferences({
    type: 'images',
    data: hits,
  });
  const decorated = useSearchEventDecorations(hits, items as { id: number }[], { entity: 'Image' });

  const query = indexUiState.query?.trim();
  const similar = useSimilarImage();
  // A typed query replaces "more like this": drop it from the URL too, or clearing the query would
  // bring it back.
  const clearSimilar = similar.refine;
  const similarTo = query ? undefined : similar.imageId;
  useEffect(() => {
    if (query && similar.imageId) clearSimilar(undefined);
  }, [query, similar.imageId, clearSimilar]);
  useScrollToTopOnChange(
    JSON.stringify({
      query,
      similarTo,
      refinementList: indexUiState.refinementList,
      range: indexUiState.range,
    })
  );

  // Image search ranks by meaning, so it needs words (or an image) to rank by; filters alone list
  // nothing.
  if (!query && !similarTo) {
    const hasFilters =
      Object.values(indexUiState.refinementList ?? {}).some((values) => values.length > 0) ||
      Object.values(indexUiState.range ?? {}).some(Boolean);
    return (
      <Center mt="md">
        <Stack gap="md" align="center" maw={600}>
          <ThemeIcon size={128} radius={100} className="opacity-50">
            <IconPhotoSearch size={80} />
          </ThemeIcon>
          <Title order={1} lh={1} ta="center">
            {hasFilters ? 'Add a search term' : 'Search images'}
          </Title>
          <Text align="center">
            {hasFilters
              ? 'Image search starts from what you describe. Filters like users, tags and base model narrow those results, but they can’t list images on their own.'
              : 'Describe what you want to see, like “a red fox in the snow”, then use the filters to narrow the results.'}
          </Text>
        </Stack>
      </Center>
    );
  }

  if (hits.length === 0) {
    const NotFound = (
      <div>
        <Center>
          <Stack gap="md" align="center" maw={800}>
            {hiddenCount > 0 && (
              <Text c="dimmed">{hiddenCount} images have been hidden due to your settings</Text>
            )}
            <ThemeIcon size={128} radius={100} className="opacity-50">
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} lh={1}>
              No images found
            </Title>
            <Text align="center">
              {similarTo
                ? 'We couldn’t find images like this one. Try removing some filters.'
                : 'We have a bunch of images, but it looks like we couldn’t find any images with prompt or tags matching your query.'}
            </Text>
          </Stack>
        </Center>
      </div>
    );

    const loading = status === 'loading' || status === 'stalled';

    if (loading) {
      return (
        <div>
          <Center mt="md">
            <Loader />
          </Center>
        </div>
      );
    }

    return (
      <div>
        <Center mt="md">
          {/* Just enough time to avoid blank random page */}
          <TimeoutLoader renderTimeout={() => <>{NotFound}</>} delay={150} />
        </Center>
      </div>
    );
  }

  if (loadingPreferences) {
    return (
      <div>
        <Center mt="md">
          <Loader />
        </Center>
      </div>
    );
  }

  return (
    <Stack>
      {similarTo && (
        <Group gap="xs">
          <Text size="sm">
            Showing images like{' '}
            <Anchor component={NextLink} href={`/images/${similarTo}`} inherit>
              this image
            </Anchor>
          </Text>
          <Button size="compact-xs" variant="subtle" onClick={() => clearSimilar(undefined)}>
            Clear
          </Button>
        </Group>
      )}
      {correctedQuery && (
        <Text size="sm">
          Showing results for <strong>{correctedQuery}</strong>
        </Text>
      )}
      {hiddenCount > 0 && (
        <Text c="dimmed">{hiddenCount} images have been hidden due to your settings.</Text>
      )}
      {/* <div
        className={classes.grid}
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(290px, 1fr))`,
        }}
      >

        <ImagesProvider images={images as any}>
          {images.map((hit) => (
            <ImageCard key={hit.id} data={hit} />
          ))}
        </ImagesProvider>
      </div> */}
      <div>
        <ImagesProvider images={decorated as any}>
          <MasonryColumnsVirtual
            data={decorated as any}
            imageDimensions={(data) => {
              const width = data?.width ?? 450;
              const height = data?.height ?? 450;
              return { width, height };
            }}
            adjustHeight={(args) => adjustImagesCardHeight(args)}
            maxItemHeight={600}
            render={ImagesCardMemoized}
            itemId={(data) => data.id}
            withAds
          />
        </ImagesProvider>
      </div>
      {hits.length > 0 && isLastPage && (
        <EndOfFeed text="Try other words or filters to find more" />
      )}
      {hits.length > 0 && !isLastPage && (
        <InViewLoader
          loadFn={showMore}
          loadCondition={status === 'idle'}
          style={{ gridColumn: '1/-1' }}
        >
          <Center p="xl" style={{ height: 36 }} mt="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Stack>
  );
}

function ImageSearchLayout({ children }: { children: React.ReactNode }) {
  return (
    <SearchLayout
      indexName={IMAGES_SEARCH_INDEX}
      leftSidebar={
        <SearchLayout.Filters>
          <RenderFilters />
        </SearchLayout.Filters>
      }
    >
      {children}
    </SearchLayout>
  );
}

ImageSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <ImageSearchLayout>{page}</ImageSearchLayout>;
};

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, ctx }) => {
    const destination = legacyImageSearchDestination(features ?? {}, ctx.query);
    if (destination === 'images-feed')
      return {
        redirect: {
          destination: await imageFeedUrlFromLegacySearch(ctx.query, resolveTags),
          permanent: false,
        },
      };
    if (destination === 'models-search')
      return { redirect: { destination: '/search/models', permanent: false } };
  },
});
