import { Stack, Text, Center, Loader, Title, ThemeIcon, Group, Card, Badge } from '@mantine/core';
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
import { COMICS_SEARCH_INDEX } from '~/server/common/constants';
import { ComicsSearchIndexSortBy } from '~/components/Search/parsers/comic.parser';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { abbreviateNumber } from '~/utils/number-helpers';
import Link from 'next/link';
import classes from '~/components/Search/SearchLayout.module.scss';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.comicSearch)
      return {
        redirect: { destination: '/', permanent: false },
      };

    return { props: {} };
  },
});

export default function ComicSearch() {
  return (
    <SearchLayout.Root>
      <SearchLayout.Content>
        <SearchHeader />
        <ComicHitList />
      </SearchLayout.Content>
    </SearchLayout.Root>
  );
}

const RenderFilters = () => {
  return (
    <>
      <SortBy
        title="Sort comics by"
        items={[
          { label: 'Relevancy', value: ComicsSearchIndexSortBy[0] as string },
          { label: 'Newest', value: ComicsSearchIndexSortBy[1] as string },
          { label: 'Oldest', value: ComicsSearchIndexSortBy[2] as string },
          { label: 'Most Followed', value: ComicsSearchIndexSortBy[3] as string },
          { label: 'Most Chapters', value: ComicsSearchIndexSortBy[4] as string },
        ]}
      />
      <SearchableMultiSelectRefinementList title="Genre" attribute="genre" searchable />
      <ClearRefinements />
    </>
  );
};

export function ComicHitList() {
  const { items, showMore, isLastPage } = useInfiniteHitsTransformed<'comics'>();
  const { status } = useInstantSearch();

  if (items.length === 0) {
    const NotFound = (
      <div>
        <Center>
          <Stack gap="md" align="center" maw={800}>
            <ThemeIcon size={128} radius={100} className="opacity-50">
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} lh={1}>
              No comics found
            </Title>
            <Text align="center">
              We have a bunch of comics, but it looks like we couldn&rsquo;t find any matching your
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
          gridTemplateColumns: `repeat(auto-fill, minmax(280px, 1fr))`,
        }}
      >
        {items.map((hit) => (
          <Link key={hit.id} href={`/comics/${hit.id}`} passHref style={{ textDecoration: 'none' }}>
            <Card withBorder radius="md" p={0} className="cursor-pointer hover:shadow-md">
              <Card.Section>
                {hit.coverImageUrl ? (
                  <EdgeMedia
                    src={hit.coverImageUrl}
                    alt={hit.name}
                    type="image"
                    width={450}
                    style={{ width: '100%', height: 200, objectFit: 'cover' }}
                  />
                ) : (
                  <Center style={{ height: 200 }} className="bg-gray-1 dark:bg-dark-6">
                    <Text c="dimmed">No cover</Text>
                  </Center>
                )}
              </Card.Section>
              <Stack gap="xs" p="sm">
                <Text fw={600} lineClamp={1}>
                  {hit.name}
                </Text>
                <Group gap="xs">
                  <UserAvatar user={hit.user} size="xs" withUsername />
                </Group>
                <Group gap="xs">
                  {hit.genre && (
                    <Badge size="xs" variant="light">
                      {hit.genre}
                    </Badge>
                  )}
                  {hit.stats && (
                    <>
                      <Badge size="xs" variant="outline">
                        {abbreviateNumber(hit.stats.chapterCount)} chapters
                      </Badge>
                      <Badge size="xs" variant="outline">
                        {abbreviateNumber(hit.stats.followerCount)} followers
                      </Badge>
                    </>
                  )}
                </Group>
              </Stack>
            </Card>
          </Link>
        ))}
      </div>
      {items.length > 0 && !isLastPage && (
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

ComicSearch.getLayout = function getLayout(page: React.ReactNode) {
  return (
    <SearchLayout
      indexName={COMICS_SEARCH_INDEX}
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
