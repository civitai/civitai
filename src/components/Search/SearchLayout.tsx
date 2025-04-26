import { Divider, Group, Stack, Text, ThemeIcon, Tooltip, UnstyledButton } from '@mantine/core';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { IconChevronsLeft } from '@tabler/icons-react';
import { routing } from '~/components/Search/useSearchState';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client';
import { SearchIndex } from '~/components/Search/parsers/base';
import { Configure, InstantSearch, InstantSearchProps } from 'react-instantsearch';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import { RenderSearchComponentProps } from '~/components/AppLayout/AppHeader/AppHeader';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useRouter } from 'next/router';
import { useTrackEvent } from '../TrackView/track.utils';
import { z } from 'zod';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { constants } from '~/server/common/constants';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useLocalStorage } from '@mantine/hooks';
import { UiState } from 'instantsearch.js';
import styles from './SearchLayout.module.scss';

const SIDEBAR_SIZE = 377;

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

const searchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    return meilisearch.search(requests);
  },
};

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

function renderSearchComponent(props: RenderSearchComponentProps) {
  return <CustomSearchBox {...props} />;
}

const searchQuerySchema = z
  .object({
    query: z.string().trim().optional(),
    sortBy: z.string().optional(),
  })
  .passthrough();

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

  useEffect(() => {
    const result = searchQuerySchema.safeParse(router.query);
    if (!result.success) return;

    const { query, sortBy: index, ...filters } = result.data;
    if (query && index) trackSearch({ query, index, filters });
  }, [router.query]);

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
        <Configure hitsPerPage={50} attributesToHighlight={[]} />
        <AppLayout
          renderSearchComponent={renderSearchComponent}
          scrollable={isMobile ? !sidebarOpen : true}
          left={leftSidebar}
        >
          {children}
        </AppLayout>
      </InstantSearch>
    </SearchLayoutCtx.Provider>
  );
}

SearchLayout.Root = function Root({ children }: { children: React.ReactNode }) {
  return <div className={styles.root}>{children}</div>;
};

SearchLayout.Filters = function Filters({ children }: { children: React.ReactNode }) {
  const { sidebarOpen, setSidebarOpen } = useSearchLayout();
  const { classes: searchLayoutClasses } = useSearchLayoutStyles();

  return (
    <aside className={`${styles.sidebar} ${sidebarOpen ? styles.active : ''}`}>
      <Group px="md" py="xs">
        <Tooltip label="Filters & sorting" position="bottom" withArrow>
          <UnstyledButton onClick={() => setSidebarOpen(!sidebarOpen)}>
            <ThemeIcon
              size={42}
              color="gray"
              radius="xl"
              p={11}
              className={searchLayoutClasses.filterButton}
            >
              <IconChevronsLeft />
            </ThemeIcon>
          </UnstyledButton>
        </Tooltip>
        <Text size="lg">Filters &amp; sorting</Text>
      </Group>
      <Divider />
      <div className={styles.scrollable}>{children}</div>
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

export const useSearchLayoutStyles = {
  grid: {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(250px, 1fr))`,
    gap: '1rem',
    gridTemplateRows: `auto 1fr`,
    overflow: 'hidden',
  },

  filterButton: {
    background: 'var(--mantine-color-dark-6)',
    svg: {
      color: 'var(--mantine-color-dark-6)',
    },
  },
};

