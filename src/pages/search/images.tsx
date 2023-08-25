import { Box, Center, Loader, Stack, Text, ThemeIcon, Title, UnstyledButton } from '@mantine/core';
import { useEffect, useMemo } from 'react';
import { useInfiniteHits, useInstantSearch } from 'react-instantsearch';
import { useInView } from 'react-intersection-observer';
import { ImageCard, UnroutedImageCard } from '~/components/Cards/ImageCard';
import {
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { ImageSearchIndexRecord } from '~/server/search-index/images.search-index';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { SearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { IconCloudOff } from '@tabler/icons-react';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { isDefined } from '~/utils/type-guards';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { applyUserPreferencesImages } from '~/components/Search/search.utils';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import { ImagesSearchIndexSortBy } from '~/components/Search/parsers/image.parser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CollectionContributorPermission } from '@prisma/client';

export default function ImageSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Filters>
        <RenderFilters />
      </SearchLayout.Filters>
      <SearchLayout.Content>
        <SearchHeader />
        <ImagesHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

function RenderFilters() {
  return (
    <>
      <SortBy
        title="Sort images by"
        items={[
          { label: 'Relevancy', value: ImagesSearchIndexSortBy[0] as string },
          { label: 'Most Reactions', value: ImagesSearchIndexSortBy[1] as string },
          { label: 'Most Discussed', value: ImagesSearchIndexSortBy[2] as string },
          { label: 'Newest', value: ImagesSearchIndexSortBy[3] as string },
        ]}
      />
      <SearchableMultiSelectRefinementList
        title="Users"
        attribute="user.username"
        sortBy={['count:desc']}
        searchable={true}
      />
      <SearchableMultiSelectRefinementList
        title="Tags"
        attribute="tags.name"
        operator="and"
        sortBy={['count:desc']}
        searchable={true}
      />
    </>
  );
}

function ImagesHitList() {
  const { classes } = useSearchLayoutStyles();
  const { status } = useInstantSearch();
  const { ref, inView } = useInView();

  const { hits, showMore, isLastPage } = useInfiniteHits<ImageSearchIndexRecord>();
  const router = useRouter();
  const currentUser = useCurrentUser();
  const {
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const images = useMemo(() => {
    return applyUserPreferencesImages<ImageSearchIndexRecord>({
      items: hits,
      hiddenImages,
      hiddenTags,
      hiddenUsers,
      currentUserId: currentUser?.id,
    });
  }, [hits, hiddenImages, hiddenTags, hiddenUsers, currentUser]);

  const hiddenItems = hits.length - images.length;

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && status === 'idle' && !isLastPage) {
      showMore();
    }
  }, [status, inView, showMore, isLastPage]);

  if (hits.length === 0) {
    const NotFound = (
      <Box>
        <Center>
          <Stack spacing="md" align="center" maw={800}>
            {hiddenItems > 0 && (
              <Text color="dimmed">
                {hiddenItems} models have been hidden due to your settings.
              </Text>
            )}
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} inline>
              No images found
            </Title>
            <Text align="center">
              We have a bunch of images, but it looks like we couldn&rsquo;t find any images with
              prompt or tags matching your query.
            </Text>
          </Stack>
        </Center>
      </Box>
    );

    return (
      <Box>
        <Center mt="md">
          <TimeoutLoader renderTimeout={() => <>{NotFound}</>} />
        </Center>
      </Box>
    );
  }

  if (loadingPreferences) {
    return (
      <Box>
        <Center mt="md">
          <Loader />
        </Center>
      </Box>
    );
  }

  return (
    <Stack>
      {hiddenItems > 0 && (
        <Text color="dimmed">{hiddenItems} models have been hidden due to your settings.</Text>
      )}
      <div
        className={classes.grid}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(290px, 1fr))`,
        }}
      >
        {images.map((hit) => (
          <ImageCard key={hit.id} data={hit} />
        ))}
      </div>
      {hits.length > 0 && (
        <Center ref={ref} sx={{ height: 36 }} mt="md">
          {!isLastPage && status === 'idle' && <Loader />}
        </Center>
      )}
    </Stack>
  );
}

ImageSearch.getLayout = function getLayout(page: React.ReactNode) {
  return <SearchLayout indexName={IMAGES_SEARCH_INDEX}>{page}</SearchLayout>;
};

export const getServerSideProps = createServerSideProps({
  resolver: async ({ features }) => {
    if (!features?.imageSearch) return { notFound: true };
  },
});
