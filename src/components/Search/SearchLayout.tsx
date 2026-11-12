import { Divider, Group, Stack, Text, ThemeIcon, UnstyledButton } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';

import { Alert } from '@mantine/core';
import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { IconAlertTriangle, IconChevronsLeft } from '@tabler/icons-react';
import { routing } from '~/components/Search/useSearchState';
import { createInstantMeiliSearch } from '~/components/Search/site-search-client';
import { withSemanticImageSearch } from '~/components/Search/semanticImageSearchClient';
import { withSemanticArticleSearch } from '~/components/Search/semanticArticleSearchClient';
import { withUserHydration } from '~/components/Search/userHydration';
import { createResilientSearchClient } from '~/components/Search/resilientSearchClient';
import {
  searchAvailability,
  useSearchAvailabilityStore,
} from '~/components/Search/search-availability.store';
import type { SearchIndex } from '~/components/Search/parsers/base';
import type { InstantSearchProps } from 'react-instantsearch';
import { Configure, InstantSearch, useInstantSearch } from 'react-instantsearch';
import { SEARCH_HITS_PER_PAGE } from '~/components/Search/search.constants';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import type { RenderSearchComponentProps } from '~/components/AppLayout/AppHeader/AppHeader';
import { useRouter } from 'next/router';
import { useTrackEvent } from '../TrackView/track.utils';
import * as z from 'zod';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { constants } from '~/server/common/constants';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useLocalStorage } from '@mantine/hooks';
import type { UiState } from 'instantsearch.js';
import { SearchRefusalNotice } from '~/components/Search/SearchRefusalNotice';
import { useSearchRefusal } from '~/components/Search/useSearchRefusal';
import classes from './SearchLayout.module.scss';
import clsx from 'clsx';

const meilisearch = createInstantMeiliSearch({ primaryKey: 'id', keepZeroFacets: true });

// Wrap the Meili client so a backend outage/blip degrades to an empty result set
// (with a "temporarily unavailable" banner) instead of throwing an uncaught
// `MeiliSearchCommunicationError`. Happy path is unchanged: a successful search
// returns Meili's response verbatim. The availability store is the side-channel
// used to render the banner (the swallowed error never reaches
// `useInstantSearch().status`).
const searchClient: InstantSearchProps['searchClient'] = withUserHydration(
  createResilientSearchClient(withSemanticArticleSearch(withSemanticImageSearch(meilisearch)), {
    onError: () => searchAvailability.setUnavailable(true),
    onSuccess: () => searchAvailability.setUnavailable(false),
  })
);

// #region [ImageGuardContext]
type SearchLayoutState = {
  sidebarOpen: boolean;
  setSidebarOpen: (value: boolean) => void;
};

const SearchLayoutCtx = createContext<SearchLayoutState>({} as any);
export const useSearchLayout = () => {
  const context = useContext(SearchLayoutCtx);
  if (!context) throw new Error('useSearchLayoutIdx can only be used inside SearchLayoutCtx');
  return context;
};

// Component to monitor InstantSearch state changes for profanity/illegal detection
function SearchStateMonitor({ onQueryChange }: { onQueryChange: (query: string) => void }) {
  const { uiState } = useInstantSearch();

  useEffect(() => {
    // Get the current query from InstantSearch state
    const indexName = Object.keys(uiState)?.[0];
    const currentQuery = indexName ? uiState[indexName]?.query || '' : '';
    onQueryChange(currentQuery);
  }, [uiState, onQueryChange]);

  return null;
}

function renderSearchComponent(props: RenderSearchComponentProps) {
  return <CustomSearchBox {...props} />;
}

const searchQuerySchema = z.looseObject({
  query: z.string().trim().optional(),
  sortBy: z.string().optional(),
});

export function SearchLayout({
  children,
  indexName,
  leftSidebar,
  initialUiState,
}: {
  children: React.ReactNode;
  indexName: SearchIndex;
  leftSidebar?: React.ReactNode;
  initialUiState?: UiState;
}) {
  const isMobile = useIsMobile();
  const [sidebarOpenLocalStorage, setSidebarOpenLocalStorage] = useLocalStorage({
    key: `search-sidebar`,
    defaultValue: true,
  });
  const [sidebarOpenState, setSidebarOpenState] = useState(false);
  const sidebarOpen = isMobile ? sidebarOpenState : sidebarOpenLocalStorage;
  const setSidebarOpen = (value: boolean) => {
    setSidebarOpenState(value);
    setSidebarOpenLocalStorage(value);
  };

  const ctx = useMemo(() => ({ sidebarOpen, setSidebarOpen }), [sidebarOpen]);

  const router = useRouter();
  const { trackSearch } = useTrackEvent();

  // State to track the current InstantSearch query
  const [instantSearchQuery, setInstantSearchQuery] = useState('');

  // Cache the parsed search query result to avoid multiple parsing
  const parsedQuery = useMemo(() => {
    const result = searchQuerySchema.safeParse(router.query);
    if (!result.success) return null;
    return result.data;
  }, [router.query]);

  // Use both URL query and InstantSearch query for comprehensive detection
  const urlQuery = parsedQuery?.query || '';
  const searchQuery = instantSearchQuery || urlQuery;

  useEffect(() => {
    if (!parsedQuery) return;

    const { query, sortBy: index, ...filters } = parsedQuery;

    if (query && index) trackSearch({ query, index, filters });
  }, [parsedQuery]);

  // Callback for InstantSearch state changes
  const handleQueryChange = useCallback((query: string) => {
    setInstantSearchQuery(query);
  }, []);

  // The search pages refuse only these two, as they always have; the feed refuses more.
  const { refusal, profanityMatches } = useSearchRefusal(searchQuery, parsedQuery?.sortBy);
  const shownRefusal = refusal === 'illegal' || refusal === 'profanity' ? refusal : undefined;
  const isSearchUnavailable = useSearchAvailabilityStore((state) => state.unavailable);

  return (
    <SearchLayoutCtx.Provider value={ctx}>
      <InstantSearch
        // Needs re-render. Otherwise the prev. index will screw up the app.
        key={indexName}
        searchClient={searchClient}
        indexName={indexName}
        routing={routing}
        future={{ preserveSharedStateOnUnmount: true }}
        initialUiState={initialUiState}
      >
        <Configure hitsPerPage={SEARCH_HITS_PER_PAGE} attributesToHighlight={[]} />
        <SearchStateMonitor onQueryChange={handleQueryChange} />
        <AppLayout
          renderSearchComponent={renderSearchComponent}
          scrollable={isMobile ? !sidebarOpen : true}
          left={leftSidebar}
        >
          {shownRefusal ? (
            <SearchLayout.Root>
              <SearchLayout.Content>
                <SearchRefusalNotice refusal={shownRefusal} profanityMatches={profanityMatches} />
              </SearchLayout.Content>
            </SearchLayout.Root>
          ) : (
            <>
              {isSearchUnavailable && (
                <SearchLayout.Content>
                  <Alert
                    icon={<IconAlertTriangle size={18} />}
                    color="yellow"
                    variant="light"
                    title="Search is temporarily unavailable"
                  >
                    We couldn&apos;t reach search just now. This is usually brief — please try your
                    search again in a moment.
                  </Alert>
                </SearchLayout.Content>
              )}
              {children}
            </>
          )}
        </AppLayout>
      </InstantSearch>
    </SearchLayoutCtx.Provider>
  );
}

SearchLayout.Root = function Root({ children }: { children: React.ReactNode }) {
  return <div className={classes.root}>{children}</div>;
};

SearchLayout.Filters = function Filters({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, setSidebarOpen } = useSearchLayout();

  return (
    <aside className={clsx(classes.sidebar, { [classes.active]: sidebarOpen })}>
      <Group px="md" py="xs">
        <Tooltip label="Filters & sorting" position="bottom" withArrow>
          <UnstyledButton onClick={() => setSidebarOpen(!sidebarOpen)}>
            <ThemeIcon
              size={42}
              className="bg-gray-1 text-black dark:bg-dark-6 dark:text-white"
              radius="xl"
              p={11}
            >
              <IconChevronsLeft />
            </ThemeIcon>
          </UnstyledButton>
        </Tooltip>
        <Text size="lg">Filters &amp; sorting</Text>
      </Group>
      <Divider />
      <ScrollArea className="h-full p-4">{children}</ScrollArea>
    </aside>
  );
};

const maxColumnCount = 7;
SearchLayout.Content = function Content({ children }: { children: React.ReactNode }) {
  return (
    <MasonryProvider
      columnWidth={constants.cardSizes.model}
      maxColumnCount={maxColumnCount}
      maxSingleColumnWidth={450}
      className="flex-1"
    >
      <MasonryContainer p={0}>
        <Stack>{children}</Stack>
      </MasonryContainer>
    </MasonryProvider>
  );
};
