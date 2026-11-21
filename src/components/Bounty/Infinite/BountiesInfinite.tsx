import type { GetInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { Center, Loader, LoadingOverlay } from '@mantine/core';
import { isEqual } from 'lodash-es';
import { useRef } from 'react';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { removeEmpty } from '~/utils/object-helpers';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import { BountyCard } from '~/components/Cards/BountyCard';
import { useBountyFilters, useQueryBounties, useSemanticBountyFeed } from '../bounty.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useFeedSearchQuery } from '~/components/Filters/FeedSearchInput';
import { FeedSearchSummary } from '~/components/Search/FeedSearchSummary';
import { SearchRefusalNotice } from '~/components/Search/SearchRefusalNotice';
import { useSearchRefusal } from '~/components/Search/useSearchRefusal';
import { isSearchRefusedError } from '~/components/Search/search-refusal';
import { useScrollToTopOnChange } from '~/hooks/useScrollToTopOnChange';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function BountiesInfinite({ searchable, ...props }: Props) {
  const features = useFeatureFlags();
  // Only a searchable feed with the flag reads the page's `?query=` and pays for the query checks.
  return searchable && features.semanticBountySearch ? (
    <SearchableBountiesFeed {...props} />
  ) : (
    <BountiesFeed {...props} />
  );
}

/** The feed's filters: the saved ones under the caller's, stable while their content is. */
function useInfiniteBountyFilters({ filters: filterOverrides }: Props) {
  const bountiesFilters = useBountyFilters();
  const computedFilters = removeEmpty({ ...bountiesFilters, ...filterOverrides });
  // Stabilize identity so query keys only update on real content change.
  const filtersRef = useRef(computedFilters);
  if (!isEqual(filtersRef.current, computedFilters)) filtersRef.current = computedFilters;
  return filtersRef.current;
}

function SearchableBountiesFeed(props: Props) {
  const filters = useInfiniteBountyFilters(props);
  const searchText = useFeedSearchQuery();
  // A ?query= can arrive by link or redirect, past the search bar's own checks.
  const { refusal, profanityMatches } = useSearchRefusal(
    searchText,
    'bounties_semantic',
    'semantic'
  );
  const search = useSemanticBountyFeed(filters, refusal ? undefined : searchText);
  useScrollToTopOnChange(search.searchKey);
  const shownRefusal = refusal ?? (isSearchRefusedError(search.error) ? 'profanity' : undefined);
  if (shownRefusal)
    return <SearchRefusalNotice refusal={shownRefusal} profanityMatches={profanityMatches} />;
  return searchText ? (
    <BountiesFeed {...props} search={{ text: searchText, ...search }} />
  ) : (
    <BountiesFeed {...props} />
  );
}

type FeedSearch = ReturnType<typeof useSemanticBountyFeed> & { text: string };

function BountiesFeed({ showEof = true, search, ...props }: Props & { search?: FeedSearch }) {
  const filters = useInfiniteBountyFilters(props);
  const searchFailed = !!search?.isError;
  const searching = !!search && !searchFailed;
  const feed = useQueryBounties(
    // The feed's own query is a keyword match, used only as the fallback.
    { ...filters, query: search?.text },
    { keepPreviousData: true, enabled: !searching }
  );
  const { bounties, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    search && searching ? search : feed;

  return (
    <>
      {search && (
        <FeedSearchSummary
          noun="Bounties"
          query={search.text}
          correctedQuery={searching ? search.correctedQuery : undefined}
          failed={searchFailed}
          onRetry={() => search.refetch()}
        />
      )}
      {!bounties.length && isFetching ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!bounties.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGridVirtual
            data={bounties}
            render={BountyCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
            aspectRatio="square"
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
        <NoContent />
      )}
    </>
  );
}

type Props = {
  filters?: Partial<GetInfiniteBountySchema>;
  showEof?: boolean;
  /** The feed answers the page's `?query=` with the semantic search, under semanticBountySearch. */
  searchable?: boolean;
};
