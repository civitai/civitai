import { Center, Loader, LoadingOverlay } from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { Model3DCard } from '~/components/Cards/Model3DCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import { NoContent } from '~/components/NoContent/NoContent';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GetModel3DsInfiniteInput } from '~/server/schema/model3d.schema';
import { trpc } from '~/utils/trpc';

type Model3DsInfiniteFilters = Omit<GetModel3DsInfiniteInput, 'limit' | 'cursor' | 'browsingLevel'>;

export function Model3DsInfinite({ filters }: { filters: Model3DsInfiniteFilters }) {
  const features = useFeatureFlags();
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, isFetching, isRefetching, hasNextPage, fetchNextPage } =
    trpc.model3d.getInfinite.useInfiniteQuery(
      { ...filters, limit: 50, browsingLevel },
      {
        enabled: !!features.model3dFeed,
        getNextPageParam: (last) => last.nextCursor,
        placeholderData: keepPreviousData,
      }
    );

  const rawItems = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data?.pages]);
  const { items, loadingPreferences } = useApplyHiddenPreferences({
    type: 'model3d',
    data: rawItems,
    isRefetching,
  });

  if (!features.model3dFeed) return <NoContent py="lg" />;

  if (isLoading || loadingPreferences)
    return (
      <Center p="xl">
        <Loader size="xl" />
      </Center>
    );

  if (!items.length) return <NoContent py="lg" />;

  return (
    <div className="relative">
      <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
      <MasonryGridVirtual
        data={items}
        render={Model3DCard}
        itemId={(x) => x.id}
        empty={<NoContent />}
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
      {!hasNextPage && <EndOfFeed />}
    </div>
  );
}
