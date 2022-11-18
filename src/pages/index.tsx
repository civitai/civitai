import { Group, Loader, Stack, Container, Center, ThemeIcon, Text, Title } from '@mantine/core';
import Head from 'next/head';
import { useEffect, useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import { useInView } from 'react-intersection-observer';
import { MasonryList } from '~/components/MasonryList/MasonryList';
import { ListSort } from '~/components/ListSort/ListSort';
import { ListPeriod } from '~/components/ListPeriod/ListPeriod';
import { useModelFilters } from '~/hooks/useModelFilters';
import { IconCloudOff } from '@tabler/icons';
import { ListFilter } from '~/components/ListFilter/ListFilter';

function Home() {
  const { ref, inView } = useInView();

  const { filters } = useModelFilters();

  const {
    data,
    isLoading,
    // isFetching,
    fetchNextPage,
    // fetchPreviousPage,
    hasNextPage,
    // hasPreviousPage,
  } = trpc.model.getAll.useInfiniteQuery(
    { limit: 100, ...filters },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
    }
  );

  useEffect(() => {
    if (inView) {
      fetchNextPage();
    }
  }, [fetchNextPage, inView]);

  const models = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [], [data]);

  return (
    <>
      <Head>
        <meta name="description" content="Community driven AI model sharing tool" />
      </Head>
      <Container size="xl" p={0}>
        {filters.user && <Title>Models by {filters.user}</Title>}
        <Stack spacing="xs">
          <Group position="apart">
            <ListSort />
            <Group spacing="xs">
              <ListPeriod />
              <ListFilter />
            </Group>
          </Group>
          {isLoading ? (
            <Center>
              <Loader size="xl" />
            </Center>
          ) : !!models.length ? (
            <MasonryList columnWidth={300} data={models} />
          ) : (
            <Stack align="center">
              <ThemeIcon size={128} radius={100}>
                <IconCloudOff size={80} />
              </ThemeIcon>
              <Text size={32} align="center">
                No results found
              </Text>
              <Text align="center">
                {"Try adjusting your search or filters to find what you're looking for"}
              </Text>
            </Stack>
          )}
          {!isLoading && hasNextPage && (
            <Group position="center" ref={ref}>
              <Loader />
            </Group>
          )}
        </Stack>
      </Container>
    </>
  );
}

// Home.getLayout = (page: React.ReactElement) => <>{page}</>;
export default Home;
