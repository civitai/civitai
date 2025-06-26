import {
  Anchor,
  Center,
  Divider,
  Group,
  List,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { IconAlertTriangle, IconChevronsLeft } from '@tabler/icons-react';
import { routing } from '~/components/Search/useSearchState';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import Link from 'next/link';
import { env } from '~/env/client';
import type { SearchIndex } from '~/components/Search/parsers/base';
import type { InstantSearchProps } from 'react-instantsearch';
import { Configure, InstantSearch } from 'react-instantsearch';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import type { RenderSearchComponentProps } from '~/components/AppLayout/AppHeader/AppHeader';
import { useRouter } from 'next/router';
import { useTrackEvent } from '../TrackView/track.utils';
import { z } from 'zod';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { constants } from '~/server/common/constants';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useLocalStorage } from '@mantine/hooks';
import type { UiState } from 'instantsearch.js';
import { includesInappropriate } from '~/utils/metadata/audit';
import classes from './SearchLayout.module.scss';
import clsx from 'clsx';

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

  const isIllegalSearch = useMemo(() => {
    const result = searchQuerySchema.safeParse(router.query);
    if (!result.success) return;

    const { query, sortBy: index, ...filters } = result.data;

    if (query) {
      const illegalSearch = includesInappropriate({ prompt: query });
      return illegalSearch === 'minor';
    }

    return false;
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
          {isIllegalSearch ? (
            <SearchLayout.Root>
              <SearchLayout.Content>
                <Center>
                  <Stack maw={750} align="center" justify="center" className="h-full">
                    <Stack align="center" gap={0}>
                      <IconAlertTriangle size={42} color="red" />
                      <Text weight={700} size="xl" c="red">
                        Warning
                      </Text>
                    </Stack>
                    <Text align="center">
                      Your search may be for{' '}
                      <Text span weight={700} c="red">
                        illegal and abusive sexual material involving minors
                      </Text>
                      .
                    </Text>
                    <Text align="center">
                      Viewing, sharing, or creating such content is a{' '}
                      <Text span weight={700}>
                        serious crime
                      </Text>
                      . If you feel worried about your sexual thoughts about anyone under 18,{' '}
                      <Text span weight={700}>
                        free, confidential, and anonymous help is available
                      </Text>
                      :
                    </Text>
                    <List spacing="xs" size="md" center>
                      <List.Item>
                        <Text span weight={700}>
                          Phone (UK)
                        </Text>{' '}
                        Stop It Now! helpline —{' '}
                        <Text span weight={700}>
                          0808 1000 900
                        </Text>
                        <br />
                        <Text size="xs" c="dimmed">
                          (24/7, no caller ID saved)
                        </Text>
                      </List.Item>
                      <List.Item>
                        <Text span weight={700}>
                          Online Support (global)
                        </Text>{' '}
                        <Anchor
                          href="https://get-help.stopitnow.org.uk"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Get Help
                        </Anchor>{' '}
                        – self-help tools, live chat, and secure email
                      </List.Item>
                    </List>
                    <Text align="center" c="dimmed" size="sm" mt="md">
                      We strictly enforce our{' '}
                      <Anchor href="/content/tos#content-policies" target="_blank">
                        Terms of Service
                      </Anchor>
                      . Abuse will be reported and may lead to criminal investigation. Visit our{' '}
                      <Anchor href="/safety" target="_blank">
                        Safety Center
                      </Anchor>{' '}
                      for more information.
                    </Text>
                    <Anchor component={Link} href="/" mt="md">
                      <Text size="md">Go Back ↩︎</Text>
                    </Anchor>
                  </Stack>
                </Center>
              </SearchLayout.Content>
            </SearchLayout.Root>
          ) : (
            <>{children}</>
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
