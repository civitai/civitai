import { Group, Loader, Stack, Container } from '@mantine/core';
import Head from 'next/head';
import { useEffect, useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import { GetAllModelsReturnType } from '~/server/services/models/getAllModels';
import { useInView } from 'react-intersection-observer';
import { MasonryList } from '~/components/MasonryList/MasonryList';
import { ListSort } from '~/components/ListSort/ListSort';
import { IsHydrated } from '~/components/IsHydrated/IsHydrated';
import { ListPeriod } from '~/components/ListPeriod/ListPeriod';
import { ListSearch } from '~/components/ListSearch/ListSearch';
import { useModelFilters } from '~/hooks/useModelFilters';

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
      getNextPageParam: (lastPage: any) => lastPage.nextCursor,
      getPreviousPageParam: (firstPage: any) => firstPage.prevCursor,
    }
  );

  useEffect(() => {
    if (inView) {
      fetchNextPage();
    }
  }, [inView]); //eslint-disable-line

  const models = useMemo(
    (): GetAllModelsReturnType['items'] => data?.pages.flatMap((x) => x.items) ?? [],
    [data]
  );

  return (
    <>
      <Head>
        <meta name="description" content="Community driven AI model sharing tool" />
      </Head>
      <Container size="xl" p={0}>
        <Stack spacing="xs">
          <IsHydrated>
            <Group position="apart">
              <ListSort />
              <ListSearch />
              <ListPeriod />
            </Group>
          </IsHydrated>
          <MasonryList columnWidth={300} data={models} />
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
