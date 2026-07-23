import { Center, Loader, LoadingOverlay, Stack } from '@mantine/core';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
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
import { Model3DCategories } from '~/components/Model3D/Feed/Model3DCategories';
import { NoContent } from '~/components/NoContent/NoContent';
import { useDomainColor } from '~/hooks/useDomainColor';
import { Model3DSort } from '~/server/schema/model3d.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { parseNumericStringArray } from '~/utils/query-string-helpers';
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
 *   - Category-tag scroller via `Model3DCategories` — mod-curated tags
 *     linked from the `'model3d category'` system tag (mirrors what
 *     `/images`, `/posts`, `/articles` do)
 *   - Animated toggle — filters on the PolyGen `enableAnimation` flag
 *     stored on `Model3D.generationParams`. Rigging used to have its own
 *     toggle but the Meshy API binds rigging to animation (rigging is
 *     required when animation is enabled), so we now expose a single
 *     "Animate" affordance and `toMeshyPolyGenInput` pins
 *     `enableRigging = enableAnimation`.
 *   - Include PG-13 toggle — green-domain, logged-in viewers only; opts the
 *     feed out of the PG-only cap the domain otherwise forces.
 *
 * State lives on the URL (sort / period / tags / animated) so deep links +
 * back/forward retain filter context. Switching any filter resets the
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

  // ---- URL-backed filter state ------------------------------------------------
  const sort: Model3DSort = useMemo(() => {
    const raw = typeof query.sort === 'string' ? query.sort : undefined;
    return raw && SORT_VALUES.has(raw) ? (raw as Model3DSort) : Model3DSort.Newest;
  }, [query.sort]);

  const period: MetricTimeframe = useMemo(() => {
    const raw = typeof query.period === 'string' ? query.period : undefined;
    return raw && PERIOD_VALUES.has(raw) ? (raw as MetricTimeframe) : MetricTimeframe.AllTime;
  }, [query.period]);

  // Category-tag selection now rides on the canonical `?tags=` array (the
  // `Model3DCategories` scroller emits + reads it, mirroring how the other
  // feed pages do it). The bespoke single `?tagId=` query param is gone.
  const tagIds = useMemo(
    () => parseNumericStringArray(router.query.tags) ?? [],
    [router.query.tags]
  );

  const animated = query.animated === 'true';
  // Mod/owner-only "unrated" filter — the server ignores it for other viewers.
  const unrated = query.unrated === 'true';
  const includePG13 = query.includePG13 === 'true';

  // ---- Feed -------------------------------------------------------------------
  // The server-side `getModel3DsInfinite` SQL filter clamps Model3D.nsfwLevel
  // to bits inside `browsingLevel` (see `model3d.service.ts`), so passing the
  // current browsing level here gives us paging-correct counts. The client-
  // side `useApplyHiddenPreferences` below applies the per-user hidden-image /
  // hidden-user / hidden-tag overlay that lives only in the browser session.
  const rawBrowsingLevel = useBrowsingLevelDebounced();
  const domainColor = useDomainColor();
  // On the green (SFW) domain we default to PG only; users opt in to PG-13 via
  // the feed filter, which narrows the forced domain cap
  // (sfwBrowsingLevelsFlag = PG | PG-13) down to PG. Mirrors `ImagesInfinite`.
  const browsingLevel =
    domainColor === 'green' && !includePG13
      ? Flags.intersection(rawBrowsingLevel, publicBrowsingLevelsFlag)
      : rawBrowsingLevel;
  const { data, isLoading, isFetching, isRefetching, hasNextPage, fetchNextPage } =
    trpc.model3d.getInfinite.useInfiniteQuery(
      {
        limit: 50,
        sort,
        period,
        tagIds: tagIds.length ? tagIds : undefined,
        animated: animated || undefined,
        unrated: unrated || undefined,
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
          {/* Category-tag scroller — mod-curated set linked from the
              `'model3d category'` system tag, fetched by
              `Model3DCategories` via `useCategoryTags`. Matches what
              `/images`, `/posts`, and `/articles` show in the same slot. */}
          <Model3DCategories />

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
