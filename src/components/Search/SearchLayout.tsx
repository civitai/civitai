import {
  Container,
  createStyles,
  Divider,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';

import {
  createContext,
  Dispatch,
  SetStateAction,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { IconChevronsLeft } from '@tabler/icons-react';
import { routing } from '~/components/Search/useSearchState';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client.mjs';
import { SearchIndex } from '~/components/Search/parsers/base';
import { Configure, InstantSearch, InstantSearchProps } from 'react-instantsearch';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import { RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
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

const useStyles = createStyles((theme, _, getRef) => {
  return {
    sidebar: {
      height: '100%',
      marginLeft: `-${SIDEBAR_SIZE}px`,
      width: `${SIDEBAR_SIZE}px`,

      transition: 'margin 200ms ease',
      borderRight: '2px solid',
      borderColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],
      zIndex: 200,
      background: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
      display: 'flex',
      flexDirection: 'column',

      [containerQuery.smallerThan('sm')]: {
        top: 0,
        left: 0,
        height: '100%',
        width: '100%',
        marginLeft: `-100%`,
        position: 'absolute',
      },
    },

    scrollable: {
      padding: theme.spacing.md,
      overflowY: 'auto',
      flex: 1,
    },

    root: { height: '100%', width: '100%', display: 'flex' },

    active: {
      marginLeft: '0 !important',
    },
  };
});

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
}: {
  children: React.ReactNode;
  indexName: SearchIndex;
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
      >
        <Configure hitsPerPage={50} attributesToHighlight={[]} />
        <AppLayout renderSearchComponent={renderSearchComponent}>{children}</AppLayout>
      </InstantSearch>
    </SearchLayoutCtx.Provider>
  );
}

SearchLayout.Root = function Root({ children }: { children: React.ReactNode }) {
  const { classes } = useStyles();

  return <div className={classes.root}>{children}</div>;
};

SearchLayout.Filters = function Filters({ children }: { children: React.ReactNode }) {
  const { classes, cx } = useStyles();
  const { sidebarOpen, setSidebarOpen } = useSearchLayout();
  const { classes: searchLayoutClasses } = useSearchLayoutStyles();

  return (
    <div className={cx(classes.sidebar, { [classes.active]: sidebarOpen })}>
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
      <div className={classes.scrollable}>{children}</div>
    </div>
  );
};

const maxColumnCount = 7;
SearchLayout.Content = function Content({ children }: { children: React.ReactNode }) {
  return (
    <ScrollArea p="md">
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={maxColumnCount}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer p={0}>
          <Stack>{children}</Stack>
        </MasonryContainer>
      </MasonryProvider>
    </ScrollArea>
  );
};

export const useSearchLayoutStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateColumns: `repeat(auto-fill, minmax(250px, 1fr))`,
    columnGap: theme.spacing.md,
    gridTemplateRows: `auto 1fr`,
    overflow: 'hidden',
    marginTop: -theme.spacing.md,

    '& > *': {
      marginTop: theme.spacing.md,
    },
  },

  filterButton: {
    background: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[2],
    svg: {
      color: theme.colorScheme === 'dark' ? undefined : theme.colors.dark[6],
    },
  },
}));
