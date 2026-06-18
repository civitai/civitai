import {
  Button,
  Center,
  Loader,
  LoadingOverlay,
  Stack,
  useComputedColorScheme,
} from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useCallback, useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { Model3DCard } from '~/components/Cards/Model3DCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { Model3DSort } from '~/server/schema/model3d.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

/**
 * 3D Models feed page.
 *
 * Flag gating lives in `getServerSideProps` (returns 404 server-side when the
 * flag is off) so unauthorized viewers never see a flash of content.
 *
 * Discovery affordances:
 *   - SortFilter (Newest / Most Downloaded / Highest Rated / Most Liked)
 *   - PeriodFilter (Day / Week / Month / Year / AllTime)
 *   - Tag chip row, pulled from `model3d.getTags` (tags actually used on
 *     Model3Ds, ranked by usage count)
 *   - Rigged / Animated toggles — filter on the PolyGen `enableRigging` /
 *     `enableAnimation` flags stored on `Model3D.generationParams`
 *
 * State lives on the URL (sort / period / tagId / rigged / animated) so deep
 * links + back/forward retain filter context. Switching any filter resets the
 * infinite-query cursor automatically — TanStack Query re-keys on input.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.model3dFeed) return { notFound: true };
    return { props: {} };
  },
});

const SORT_VALUES = new Set<string>(Object.values(Model3DSort));
const PERIOD_VALUES = new Set<string>(Object.values(MetricTimeframe));

function Model3DsPage() {
  const router = useRouter();
  const { query } = router;
  const colorScheme = useComputedColorScheme('dark');

  // ---- URL-backed filter state ------------------------------------------------
  const sort: Model3DSort = useMemo(() => {
    const raw = typeof query.sort === 'string' ? query.sort : undefined;
    return raw && SORT_VALUES.has(raw) ? (raw as Model3DSort) : Model3DSort.Newest;
  }, [query.sort]);

  const period: MetricTimeframe = useMemo(() => {
    const raw = typeof query.period === 'string' ? query.period : undefined;
    return raw && PERIOD_VALUES.has(raw) ? (raw as MetricTimeframe) : MetricTimeframe.AllTime;
  }, [query.period]);

  const activeTagId: number | undefined = useMemo(() => {
    const raw = typeof query.tagId === 'string' ? Number(query.tagId) : undefined;
    return raw && Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }, [query.tagId]);

  const rigged = query.rigged === 'true';
  const animated = query.animated === 'true';

  const setQuery = useCallback(
    (patch: Record<string, string | undefined>) => {
      router.replace(
        { pathname: router.pathname, query: removeEmpty({ ...query, ...patch }) },
        undefined,
        { shallow: true }
      );
    },
    [router, query]
  );

  // ---- Tag chip row (above grid) ---------------------------------------------
  const { data: tagsData } = trpc.model3d.getTags.useQuery({ limit: 50 });
  const tags = tagsData?.items ?? [];

  // ---- Feed -------------------------------------------------------------------
  // The server-side `getModel3DsInfinite` SQL filter clamps Model3D.nsfwLevel
  // to bits inside `browsingLevel` (see `model3d.service.ts`), so passing the
  // current browsing level here gives us paging-correct counts. The client-
  // side `useApplyHiddenPreferences` below applies the per-user hidden-image /
  // hidden-user / hidden-tag overlay that lives only in the browser session.
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, isFetching, isRefetching, hasNextPage, fetchNextPage } =
    trpc.model3d.getInfinite.useInfiniteQuery(
      {
        limit: 50,
        sort,
        period,
        tagIds: activeTagId ? [activeTagId] : undefined,
        rigged: rigged || undefined,
        animated: animated || undefined,
        browsingLevel,
      },
      {
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

  return (
    <>
      <Meta
        title="3D Models | Civitai"
        description="Browse 3D models generated and shared by the Civitai community."
        canonical="/3d-models"
        deIndex
      />

      <MasonryContainer>
        <Stack gap="md">
          {/* Tag row — popular Model3D tags, click to filter, click again to
              clear. Sort / Period / Rigged / Animated live in the sub-nav
              filter row (Model3DFeedFilters) so this page just owns tags. */}
          {tags.length > 0 && (
            <TwScrollX className="flex gap-1">
              <Button
                className="overflow-visible uppercase"
                variant={!activeTagId ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
                color={!activeTagId ? 'blue' : 'gray'}
                onClick={() => setQuery({ tagId: undefined })}
                size="compact-sm"
              >
                All
              </Button>
              {tags.map((tag) => {
                const active = activeTagId === tag.id;
                return (
                  <Button
                    key={tag.id}
                    className="overflow-visible uppercase"
                    variant={active ? 'filled' : colorScheme === 'dark' ? 'filled' : 'light'}
                    color={active ? 'blue' : 'gray'}
                    onClick={() => setQuery({ tagId: active ? undefined : String(tag.id) })}
                    size="compact-sm"
                  >
                    {tag.name}
                  </Button>
                );
              })}
            </TwScrollX>
          )}

          {isLoading || loadingPreferences ? (
            <Center p="xl">
              <Loader size="xl" />
            </Center>
          ) : items.length ? (
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
          ) : (
            <NoContent py="lg" />
          )}
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(Model3DsPage, { InnerLayout: FeedLayout, announcements: true });
