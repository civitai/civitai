import { Stack, Text, Center, Loader, Title, ThemeIcon } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import { useInstantSearch } from 'react-instantsearch';
import {
  ClearRefinements,
  SearchableMultiSelectRefinementList,
  SortBy,
} from '~/components/Search/CustomSearchComponents';
import { SearchHeader } from '~/components/Search/SearchHeader';
import { TimeoutLoader } from '~/components/Search/TimeoutLoader';
import { SearchLayout } from '~/components/Search/SearchLayout';
import { TOOLS_SEARCH_INDEX } from '~/server/common/constants';
import { ToolsSearchIndexSortBy } from '~/components/Search/parsers/tool.parser';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ToolCard } from '~/components/Cards/ToolCard';
import { trpc } from '~/utils/trpc';
import classes from '~/components/Search/SearchLayout.module.scss';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.toolSearch)
      return {
        redirect: { destination: '/', permanent: false },
      };

    return { props: {} };
  },
});

export default function ToolSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Content>
        <SearchHeader />
        <ToolHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort tools by"
        items={[
          { label: 'Relevancy', value: ToolsSearchIndexSortBy[0] as string },
          { label: 'Name (A - Z)', value: ToolsSearchIndexSortBy[1] as string },
          { label: 'Name (Z - A)', value: ToolsSearchIndexSortBy[2] as string },
          { label: 'Date Added (Oldest - Newest)', value: ToolsSearchIndexSortBy[3] as string },
          { label: 'Date Added (Newest - Oldest)', value: ToolsSearchIndexSortBy[4] as string },
        ]}
      />
      <SearchableMultiSelectRefinementList title="Type" attribute="type" searchable />
      <SearchableMultiSelectRefinementList title="Company" attribute="company" searchable />
      <ClearRefinements />
    </>
  );
};

export function ToolHitList() {
  const { items, showMore, isLastPage } = useInfiniteHitsTransformed<'tools'>();
  const { status } = useInstantSearch();
  const { data } = trpc.generation.getGenerationEngines.useQuery();

  if (items.length === 0) {
    const NotFound = (
      <div>
        <Center>
          <Stack gap="md" align="center" maw={800}>
            <ThemeIcon size={128} radius={100} className="opacity-50">
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} lh={1}>
              No tools found
            </Title>
            <Text align="center">
              We have a bunch of tools, but it looks like we couldn&rsquo;t find any matching your
              query.
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

  return (
    <Stack>
      <div
        className={classes.grid}
        style={{
          // Overwrite default sizing here.
          gridTemplateColumns: `repeat(auto-fill, minmax(350px, 1fr))`,
        }}
      >
        {items.map((hit) => {
          const match = data?.find((x) => x.engine === hit.alias && !x.disabled);
          return (
            <ToolCard key={hit.id} data={{ ...hit, alias: match?.engine as string | undefined }} />
          );
        })}
      </div>
      {items.length > 0 && !isLastPage && (
        <InViewLoader
          loadFn={showMore}
          loadCondition={status === 'idle'}
          style={{ gridColumn: '1/-1' }}
        >
          <Center p="xl" sx={{ height: 36 }} mt="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Stack>
  );
}

ToolSearch.getLayout = function getLayout(page: React.ReactNode) {
  return (
    <SearchLayout
      indexName={TOOLS_SEARCH_INDEX}
      leftSidebar={
        <SearchLayout.Filters>
          <RenderFilters />
        </SearchLayout.Filters>
      }
    >
      {page}
    </SearchLayout>
  );
};
