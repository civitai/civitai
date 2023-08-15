import {
  Container,
  createStyles,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { isEqual } from 'lodash-es';

import { createContext, Dispatch, SetStateAction, useContext, useMemo, useState } from 'react';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { IconChevronsLeft } from '@tabler/icons-react';
import { routing } from '~/components/Search/useSearchState';
import { AlgoliaMultipleQueriesQuery, instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client.mjs';
import { SearchIndex } from '~/components/Search/parsers/base';
import { InstantSearch, InstantSearchProps } from 'react-instantsearch';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import { RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';

const SIDEBAR_SIZE = 377;

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

const searchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    console.log(requests);
    return meilisearch.search(requests);
  },
};

// #region [ImageGuardContext]
type SearchLayoutState = {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
};

const SearchLayoutCtx = createContext<SearchLayoutState>({} as any);
export const useSearchLayoutCtx = () => {
  const context = useContext(SearchLayoutCtx);
  if (!context) throw new Error('useSearchLayoutIdx can only be used inside SearchLayoutCtx');
  return context;
};

const useStyles = createStyles((theme, _, getRef) => {
  const sidebarRef = getRef('sidebar');
  const contentRef = getRef('content');

  return {
    sidebar: {
      ref: sidebarRef,
      height: 'calc(100vh - 2 * var(--mantine-header-height, 50px))',
      position: 'fixed',
      left: -SIDEBAR_SIZE,
      top: 'var(--mantine-header-height,50px)',
      width: `${SIDEBAR_SIZE}px`,
      overflowY: 'auto',
      padding: theme.spacing.md,
      transition: 'transform 400ms ease',
      borderRight: '2px solid',
      borderColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],

      [theme.fn.smallerThan('sm')]: {
        top: 0,
        zIndex: 1000,
        height: '100vh',
        left: '-100vw',
        width: '100vw',
        background: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[0],
        position: 'fixed',
      },
    },

    content: {
      ref: contentRef,
      width: '100%',
      paddingLeft: 0,
      transition: 'padding-left 400ms ease',
    },

    sidebarOpen: {
      [`& .${sidebarRef}`]: {
        transform: `translate(${SIDEBAR_SIZE}px, 0)`,
        [theme.fn.smallerThan('sm')]: {
          transform: `translate(100vw, 0)`,
          paddingBottom: theme.spacing.xl,
        },
      },
      [`& .${contentRef}`]: {
        paddingLeft: `${SIDEBAR_SIZE}px`,
        [theme.fn.smallerThan('sm')]: {
          paddingLeft: 0,
        },
      },
    },
  };
});

function renderSearchComponent(props: RenderSearchComponentProps) {
  // if (true) {
  //   return null;
  // }

  return <CustomSearchBox {...props} />;
}

export function SearchLayout({
  children,
  indexName,
}: {
  children: React.ReactNode;
  indexName: SearchIndex;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const ctx = useMemo(() => ({ sidebarOpen, setSidebarOpen }), [sidebarOpen]);

  return (
    <SearchLayoutCtx.Provider value={ctx}>
      <InstantSearch
        // Needs re-render. Otherwise the prev. index will screw up the app.
        key={indexName}
        searchClient={searchClient}
        indexName={indexName}
        routing={routing}
      >
        <AppLayout renderSearchComponent={renderSearchComponent}>{children}</AppLayout>
      </InstantSearch>
    </SearchLayoutCtx.Provider>
  );
}

SearchLayout.Root = function Root({ children }: { children: React.ReactNode }) {
  const { classes, cx } = useStyles();
  const { sidebarOpen } = useSearchLayoutCtx();

  return (
    <Container fluid className={cx({ [classes.sidebarOpen]: sidebarOpen })}>
      {children}
    </Container>
  );
};

SearchLayout.Filters = function Filters({ children }: { children: React.ReactNode }) {
  const { classes } = useStyles();
  const { sidebarOpen, setSidebarOpen } = useSearchLayoutCtx();
  const { classes: searchLayoutClasses } = useSearchLayoutStyles();

  return (
    <Stack className={classes.sidebar}>
      <Group>
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
      {children}
    </Stack>
  );
};

SearchLayout.Content = function Content({ children }: { children: React.ReactNode }) {
  const { classes } = useStyles();
  return <Stack className={classes.content}>{children}</Stack>;
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
