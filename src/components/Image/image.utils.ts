import { withPlaceholderData } from '~/hooks/trpcHelpers';
import { closeModal, openConfirmModal } from '@mantine/modals';
import { hideNotification, showNotification } from '@mantine/notifications';
import { isEqual } from 'lodash-es';
import { useMemo, useRef, useState } from 'react';
import * as z from 'zod';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import type { FilterKeys } from '~/providers/FiltersProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { ImageSort } from '~/server/common/enums';
import type { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { MediaType, MetricTimeframe, ReviewReactions } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { booleanString, numericString, numericStringArray } from '~/utils/zod-helpers';

const imageSections = ['images', 'reactions'] as const;
export type ImageSections = (typeof imageSections)[number];

// Dev helper: simulate a transient search failure on the client so the retry UI
// can be tested without touching the backend. Enable via browser console:
//   localStorage.debugSearchRetry = '3000'    // base delay in ms
//   localStorage.debugSearchRetryAfter = '1'  // trigger after N successful pages
// To disable: localStorage.removeItem('debugSearchRetry')
//
// When active, callers MUST block further fetches — otherwise real requests
// keep succeeding, more images load, and the retry counter resets every cycle.
function useDebugSearchRetry(pagesLoaded: number) {
  if (typeof window === 'undefined') return { delayMs: 0, active: false };
  const raw = window.localStorage.getItem('debugSearchRetry');
  if (!raw) return { delayMs: 0, active: false };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return { delayMs: 0, active: false };
  const triggerAfter = Number(window.localStorage.getItem('debugSearchRetryAfter') ?? '1');
  if (pagesLoaded < triggerAfter) return { delayMs: 0, active: false };
  return { delayMs: parsed, active: true };
}

// output is input to getInfiniteImagesSchema
export type ImagesQueryParamSchema = z.infer<typeof imagesQueryParamSchema>;
export const imagesQueryParamSchema = z
  .object({
    baseModels: z
      .union([z.enum(baseModels).array(), z.enum(baseModels)])
      .transform((val) => (Array.isArray(val) ? val : [val]))
      .optional(),
    collectionId: numericString(),
    collectionTagId: numericString(),
    hideAutoResources: booleanString(),
    hideManualResources: booleanString(),
    followed: booleanString(),
    newCreators: booleanString(),
    fromPlatform: booleanString(),
    hidden: booleanString(),
    includeBaseModel: booleanString(),
    limit: numericString(),
    modelId: numericString(),
    modelVersionId: numericString(),
    notPublished: booleanString(),
    publishedOnly: booleanString(),
    pendingReviewOnly: booleanString(),
    period: z.enum(MetricTimeframe),
    periodMode: z.enum(['stats', 'published']).optional(),
    postId: numericString(),
    prioritizedUserIds: numericStringArray(),
    reactions: z.preprocess(
      (val) => (Array.isArray(val) ? val : [val]),
      z.array(z.enum(ReviewReactions))
    ),
    scheduled: booleanString(),
    section: z.enum(imageSections),
    sort: z.enum(ImageSort),
    tags: numericStringArray(),
    techniques: numericStringArray(),
    tools: numericStringArray(),
    types: z
      .union([z.array(z.enum(MediaType)), z.enum(MediaType)])
      .transform((val) => (Array.isArray(val) ? val : [val]))
      .optional(),
    userId: numericString(),
    username: z.coerce.string().transform(postgresSlugify),
    view: z.enum(['categories', 'feed']),
    withMeta: booleanString().optional(),
    requiringMeta: booleanString(),
    remixOfId: numericString(),
    includePG13: booleanString().optional(),
    poiOnly: booleanString(),
    minorOnly: booleanString(),
    disablePoi: booleanString(),
    disableMinor: booleanString(),
    remixesOnly: booleanString(),
    nonRemixesOnly: booleanString(),
    hideChallenges: booleanString(),
  })
  .partial();

export const useImageQueryParams = () => useZodRouteParams(imagesQueryParamSchema);

// The media-type scope a feed falls back to when its filters are cleared.
// `/images` shows images, `/videos` shows videos; model-image feeds stay
// unscoped (all media types). Returning `undefined` here would let `removeEmpty`
// drop `types` from the payload, so the feed would serve every media type.
export const getDefaultMediaTypes = (
  filterType: FilterKeys<'images' | 'videos' | 'modelImages'>
): MediaType[] | undefined => {
  if (filterType === 'images') return [MediaType.image];
  if (filterType === 'videos') return [MediaType.video];
  return undefined;
};

// could have userImages and userVideo
export const useImageFilters = (type: FilterKeys<'images' | 'videos' | 'modelImages'>) => {
  const storeFilters = useFiltersContext((state) => state[type]);
  const { query } = useImageQueryParams(); // router params are the overrides

  return removeEmpty({ ...storeFilters, ...query });
};

export const useDumbImageFilters = (defaultFilters?: Partial<GetInfiniteImagesInput>) => {
  const [filters, setFilters] = useState<Partial<GetInfiniteImagesInput>>(defaultFilters ?? {});
  const filtersUpdated = !isEqual(filters, defaultFilters);

  return {
    filters: { ...filters },
    setFilters,
    filtersUpdated,
  };
};

/** A page that reported no backend. Both branches name themselves now, so this is
 * an index page that returned nothing — i.e. the end of a feed — not a DB page. */
export const FEED_SOURCE_NONE = 'none';

/** Which backend served each loaded page, as emitted by the server. */
export function getFeedSources(pages: unknown[] | undefined): string[] {
  return (pages ?? []).map(
    (page) => (page as { source?: string } | undefined)?.source ?? FEED_SOURCE_NONE
  );
}

/**
 * The backend currently serving the feed.
 *
 * BitDex falls back to Meili PER PAGE — on an error, and routinely whenever a
 * pass accumulates zero documents — so the answer is the LAST page's backend,
 * not whether any page was BitDex. Only genuinely sourceless pages are skipped:
 * an empty terminal page is what scrolling to the end looks like and must not
 * retract a notice the whole scroll earned, while a DB page names itself 'db'
 * and DOES answer, because that is the flag going off mid-session.
 */
export function resolveFeedSource(sources: string[]): string | undefined {
  for (let i = sources.length - 1; i >= 0; i--) {
    if (sources[i] !== FEED_SOURCE_NONE) return sources[i];
  }
  return undefined;
}

/** Run-length summary (`bitdex×28,meili×12`) so a deep scroll still fits a bounded
 * column — a head-truncated raw list drops the tail, which is the half the gate read. */
export function summarizeFeedSources(sources: string[]): string {
  const runs: { source: string; count: number }[] = [];
  for (const source of sources) {
    const last = runs[runs.length - 1];
    if (last?.source === source) last.count++;
    else runs.push({ source, count: 1 });
  }
  return runs.map(({ source, count }) => (count > 1 ? `${source}x${count}` : source)).join(',');
}

export type FeedSnapshot = ReturnType<typeof buildFeedSnapshot>;

/**
 * The pages and the filters that fetched them, read in one place.
 *
 * Callers must not assemble this from separate reads: under keepPreviousData the
 * merged filters update synchronously while `data` still holds the previous
 * query's pages, and a report pairing new filters with old pages describes a feed
 * that never existed.
 */
export function buildFeedSnapshot(
  pages: unknown[] | undefined,
  filters: { sort?: unknown; period?: unknown; browsingLevel?: number },
  browsingLevel: number
) {
  const sources = getFeedSources(pages);
  return {
    sources,
    source: resolveFeedSource(sources),
    // Keeps the TAIL: the head is what a fixed slice would have kept, and the
    // tail is the half the gate actually read.
    summary: summarizeFeedSources(sources).slice(-200),
    pagesLoaded: pages?.length ?? 0,
    sort: String(filters.sort ?? ''),
    period: String(filters.period ?? ''),
    browsingLevel: filters.browsingLevel ?? browsingLevel,
  };
}

export const useQueryImages = (
  filters?: GetInfiniteImagesInput,
  options?: { keepPreviousData?: boolean; enabled?: boolean; applyHiddenPreferences?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { applyHiddenPreferences = true, ...queryOptions } = options ?? {};
  filters ??= {};
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  // Only the domains that cap browsing (green) get `browsingLevel` backfilled by
  // `applyDomainFeature`; on red/blue an absent level reaches the query as NULL and
  // `(nsfwLevel & NULL)` drops every row. Default from context so a caller that omits
  // it can't silently return zero images — inside a forced provider (minor models)
  // this is the forced level, which is what those queries should be asking for.
  const contextBrowsingLevel = useBrowsingLevelDebounced();

  // `!!currentUser` guards against `filters.userId === currentUser?.id` being
  // `undefined === undefined` for anonymous users, which treats them as the owner.
  const isOwnImages =
    !!currentUser &&
    ((!!filters.username &&
      filters.username.toLowerCase() === currentUser.username?.toLowerCase()) ||
      filters.userId === currentUser.id);
  const excludedTagIds = [
    ...(filters.excludedTagIds ?? []),
    ...(isOwnImages ? [] : browsingSettingsAddons.settings.excludedTagIds ?? []),
  ].filter(isDefined);

  const { data, isLoading, ...rest } = trpc.image.getInfinite.useInfiniteQuery(
    {
      ...filters,
      browsingLevel: filters.browsingLevel ?? contextBrowsingLevel,
      excludedTagIds,
      // OR-merge with the addon so either source can flag the filter.
      // Mods always have addon = false (BrowsingSettingsAddonsProvider), so
      // the chip controls them. Non-mods don't see the chip; the addon
      // value flows through untouched.
      disablePoi: !!filters.disablePoi || browsingSettingsAddons.settings.disablePoi,
      disableMinor: !!filters.disableMinor || browsingSettingsAddons.settings.disableMinor,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      // abortOnUnmount: true forces tRPC to forward React Query's AbortSignal
      // to the underlying fetch. Without it, queryClient.cancelQueries is a
      // no-op on the actual HTTP request — needed here so the slow-fetch
      // timeout can truly abort a hung request instead of waiting for it to
      // resolve naturally.
      trpc: { context: { skipBatch: true }, abortOnUnmount: true },
      // Disable React Query's silent auto-retry so our retry banner drives
      // every attempt. Otherwise the user sees nothing for the first failure,
      // then the banner appears belatedly.
      retry: 0,
      ...withPlaceholderData(queryOptions),
    }
  );

  // A ref, not useMemo: pairing the filters with the pages they fetched is
  // correctness here, and useMemo is a hint React may discard — a recompute on
  // the transition render would read the NEW filters against the OLD data and
  // reproduce exactly the mismatch this exists to prevent.
  const snapshotRef = useRef<{ data: typeof data; snapshot: FeedSnapshot } | null>(null);
  if (!snapshotRef.current || snapshotRef.current.data !== data) {
    snapshotRef.current = {
      data,
      snapshot: buildFeedSnapshot(data?.pages, filters, contextBrowsingLevel),
    };
  }
  const feedSnapshot = snapshotRef.current.snapshot;

  // Deduplicate items to prevent duplicates from offset pagination drift
  const flatData = useMemo(() => {
    const allItems = data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [];

    // Track IDs within this render to filter duplicates that appear across pages
    const seenIds = new Set<number>();
    const dedupedItems: typeof allItems = [];
    for (const item of allItems) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        dedupedItems.push(item);
      }
    }

    return dedupedItems;
  }, [data]);
  const { items, loadingPreferences, hiddenCount } = useApplyHiddenPreferences({
    type: 'images',
    data: flatData,
    showHidden: !!filters.hidden,
    disabled: !applyHiddenPreferences,
    isRefetching: rest.isRefetching,
  });

  // Debug-mode override so the retry UI can be exercised without a real
  // backend failure. The parent combines this with React Query's isError to
  // decide when to show the banner.
  const { delayMs: debugDelayMs, active: debugRetryActive } = useDebugSearchRetry(
    data?.pages.length ?? 0
  );

  return {
    data,
    flatData,
    feedSnapshot,
    images: items,
    removedImages: hiddenCount,
    fetchedImages: flatData?.length,
    isLoading: isLoading || loadingPreferences,
    debugRetryActive,
    debugDelayMs,
    ...rest,
  };
};

export const useQueryModelVersionImages = (
  modelVersionId: number,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, isLoading, ...rest } = trpc.image.getImagesForModelVersion.useQuery(
    {
      id: modelVersionId,
    },
    options
  );

  const images = data?.[modelVersionId]?.images;

  const { items, loadingPreferences, hiddenCount } = useApplyHiddenPreferences({
    type: 'images',
    data: images,
    isRefetching: rest.isRefetching,
  });

  return {
    data,
    flatData: images,
    images: items,
    removedImages: hiddenCount,
    fetchedImages: images?.length,
    isLoading: isLoading || loadingPreferences,
    ...rest,
  };
};

const CSAM_NOTIFICATION_ID = 'sending-report';

export function useReportCsamImages(
  options?: Parameters<typeof trpc.image.reportCsamImages.useMutation>[0]
) {
  const { onMutate, onSuccess, onError, onSettled, ...rest } = options ?? {};
  const { mutateAsync, ...reportCsamImage } = trpc.image.reportCsamImages.useMutation({
    async onMutate(...args) {
      showNotification({
        id: CSAM_NOTIFICATION_ID,
        loading: true,
        withCloseButton: false,
        autoClose: false,
        message: 'Sending report...',
      });
      await onMutate?.(...args);
    },
    async onSuccess(...args) {
      showSuccessNotification({
        title: 'Image reported',
        message: 'Your request has been received',
      });
      closeModal('confirm-csam');
      await onSuccess?.(...args);
    },
    async onError(error, ...args) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Unable to send report',
        reason: error.message ?? 'An unexpected error occurred, please try again',
      });
      await onError?.(error, ...args);
    },
    async onSettled(...args) {
      hideNotification(CSAM_NOTIFICATION_ID);
      await onSettled?.(...args);
    },
    ...rest,
  });

  const mutate = (args: Parameters<typeof reportCsamImage.mutate>[0]) => {
    openConfirmModal({
      modalId: 'confirm-csam',
      title: 'Report CSAM',
      children: `Are you sure you want to report this as CSAM?`,
      centered: true,
      labels: { confirm: 'Yes', cancel: 'Cancel' },
      confirmProps: { color: 'red', loading: reportCsamImage.isPending },
      closeOnConfirm: false,
      onConfirm: () => reportCsamImage.mutate(args),
    });
  };

  return { ...reportCsamImage, mutate };
}

export const useImageContestCollectionDetails = (
  filters: { id: number },
  options?: { enabled: boolean }
) => {
  const { data, ...rest } = trpc.image.getContestCollectionDetails.useQuery(
    { ...filters },
    { ...options }
  );

  return {
    collectionItems: data?.collectionItems ?? [],
    post: data?.post ?? null,
    ...rest,
  };
};
