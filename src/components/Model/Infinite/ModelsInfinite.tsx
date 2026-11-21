import { Button, Center, Group, Loader, LoadingOverlay } from '@mantine/core';
import { isEqual } from 'lodash-es';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRef } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ModelCardContextProvider, useModelSaleBadges } from '~/components/Cards/ModelCardContext';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { HidePaidNotice } from '~/components/Model/Infinite/HidePaidNotice';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import type { ModelQueryParams } from '~/components/Model/model.utils';
import {
  useModelFilters,
  useQueryModels,
  useSemanticModelFeed,
} from '~/components/Model/model.utils';
import { normalizeFeedQuery } from '~/components/Image/Infinite/image-feed-search';
import { FeedSearchSummary } from '~/components/Search/FeedSearchSummary';
import { SearchRefusalNotice } from '~/components/Search/SearchRefusalNotice';
import { useSearchRefusal } from '~/components/Search/useSearchRefusal';
import { isSearchRefusedError } from '~/components/Search/search-refusal';
import { useScrollToTopOnChange } from '~/hooks/useScrollToTopOnChange';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useEngagedModelsPrefetch } from '~/hooks/useEngagedModelMembership';
import type { ModelFilterSchema } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';

type InfiniteModelsProps = {
  filters?: Partial<Omit<ModelQueryParams, 'view'> & Omit<ModelFilterSchema, 'view'>>;
  disableStoreFilters?: boolean;
  showEof?: boolean;
  showAds?: boolean;
  showEmptyCta?: boolean;
  /** The models page: with `modelFeedSearch`, its `?query=` is answered by the semantic search. */
  searchable?: boolean;
};

export function ModelsInfinite(props: InfiniteModelsProps) {
  const features = useFeatureFlags();
  // Only the models page with the flag pays for the query checks and the search.
  return props.searchable && features.modelFeedSearch ? (
    <SearchableModelsFeed {...props} />
  ) : (
    <ModelsFeed {...props} />
  );
}

/** The feed's filters: the saved ones under the caller's, stable while their content is. */
function useInfiniteModelFilters({
  filters: filterOverrides = {},
  disableStoreFilters = false,
}: InfiniteModelsProps) {
  const modelFilters = useModelFilters();
  const currentUser = useCurrentUser();
  const pending = currentUser !== null && filterOverrides.username === currentUser.username;
  const computedFilters = removeEmpty({
    ...(disableStoreFilters ? filterOverrides : { ...modelFilters, ...filterOverrides }),
    pending,
  });
  // Stabilize identity so query keys only update on real content change.
  const filtersRef = useRef(computedFilters);
  if (!isEqual(filtersRef.current, computedFilters)) filtersRef.current = computedFilters;
  return filtersRef.current;
}

function SearchableModelsFeed(props: InfiniteModelsProps) {
  const filters = useInfiniteModelFilters(props);
  const browsingLevel = useBrowsingLevelDebounced();
  const text = normalizeFeedQuery(filters.query);
  // A ?query= can arrive by link or redirect, past the search bar's own checks.
  const { refusal, profanityMatches } = useSearchRefusal(text, 'models_semantic', 'semantic');
  const search = useSemanticModelFeed({ ...filters, browsingLevel }, refusal ? undefined : text);
  useScrollToTopOnChange(search.searchKey);
  const shownRefusal = refusal ?? (isSearchRefusedError(search.error) ? 'profanity' : undefined);
  if (shownRefusal)
    return <SearchRefusalNotice refusal={shownRefusal} profanityMatches={profanityMatches} />;
  return <ModelsFeed {...props} feedSearch={text ? { text, search } : undefined} />;
}

type FeedSearch = { text: string; search: ReturnType<typeof useSemanticModelFeed> };

function ModelsFeed({
  showEof = false,
  showAds,
  showEmptyCta,
  feedSearch,
  ...props
}: InfiniteModelsProps & { feedSearch?: FeedSearch }) {
  const filters = useInfiniteModelFilters(props);
  const browsingLevel = useBrowsingLevelDebounced();
  const search = feedSearch?.search;
  // A search that fails falls back to the keyword search with a banner, never an empty page.
  const searchFailed = !!search?.isError;
  const searching = !!search && !searchFailed;
  const feed = useQueryModels({ ...filters, browsingLevel }, { enabled: !searching });
  const { models, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    search && searching ? search : feed;
  const modelIds = models.map((m) => m.id);
  const salesByModelId = useModelSaleBadges(modelIds);
  useEngagedModelsPrefetch(modelIds);

  return (
    <ModelCardContextProvider
      // Under Hide Paid the card shows a free version; the link has to open that one, not the newest.
      useModelVersionRedirect={(filters?.baseModels ?? []).length > 0 || !!filters.hidePaid}
      activeBaseModels={filters?.baseModels}
      salesByModelId={salesByModelId}
      hasSaleProvider
    >
      {filters.hidePaid && !props.disableStoreFilters && <HidePaidNotice />}
      {feedSearch && (
        <FeedSearchSummary
          noun="Models"
          query={feedSearch.text}
          correctedQuery={searching ? feedSearch.search.correctedQuery : undefined}
          failed={searchFailed}
          onRetry={() => feedSearch.search.refetch()}
        />
      )}
      {!models.length && isFetching ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!models.length ? (
        <div className="relative">
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGridVirtual
            data={models}
            render={ModelCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
            withAds={showAds}
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
          {!hasNextPage && showEof && <EndOfFeed />}
        </div>
      ) : (
        <NoContent py="lg">
          {showEmptyCta && (
            <Group>
              <Link href="/models/create">
                <Button variant="default" radius="xl">
                  Upload a Model
                </Button>
              </Link>
              <Link href="/models/train">
                <Button radius="xl">Train a LoRA</Button>
              </Link>
            </Group>
          )}
        </NoContent>
      )}
    </ModelCardContextProvider>
  );
}
