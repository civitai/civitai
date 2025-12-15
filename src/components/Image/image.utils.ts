import { closeModal, openConfirmModal } from '@mantine/modals';
import { hideNotification, showNotification } from '@mantine/notifications';
import { isEqual } from 'lodash-es';
import { useMemo, useState } from 'react';
import * as z from 'zod';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import type { FilterKeys } from '~/providers/FiltersProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { ImageSort } from '~/server/common/enums';
import type { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { baseModels } from '~/shared/constants/base-model.constants';
import { MediaType, MetricTimeframe, ReviewReactions } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { booleanString, numericString, numericStringArray } from '~/utils/zod-helpers';

const imageSections = ['images', 'reactions'] as const;
export type ImageSections = (typeof imageSections)[number];

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
    fromPlatform: booleanString(),
    hidden: booleanString(),
    limit: numericString(),
    modelId: numericString(),
    modelVersionId: numericString(),
    notPublished: booleanString(),
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
    useIndex: booleanString().nullish(),
    userId: numericString(),
    username: z.coerce.string().transform(postgresSlugify),
    view: z.enum(['categories', 'feed']),
    withMeta: booleanString().optional(),
    requiringMeta: booleanString(),
    remixOfId: numericString(),
  })
  .partial();

export const useImageQueryParams = () => useZodRouteParams(imagesQueryParamSchema);

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

export const useQueryImages = (
  filters?: GetInfiniteImagesInput,
  options?: { keepPreviousData?: boolean; enabled?: boolean; applyHiddenPreferences?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { applyHiddenPreferences = true, ...queryOptions } = options ?? {};
  filters ??= {};
  const browsingSettingsAddons = useBrowsingSettingsAddons();

  const excludedTagIds = [
    ...(filters.excludedTagIds ?? []),
    ...((filters.username &&
      filters.username.toLowerCase() === currentUser?.username?.toLowerCase()) ||
    filters.userId === currentUser?.id
      ? []
      : browsingSettingsAddons.settings.excludedTagIds ?? []),
  ].filter(isDefined);

  const { data, isLoading, ...rest } = trpc.image.getInfinite.useInfiniteQuery(
    {
      ...filters,
      excludedTagIds,
      disablePoi: browsingSettingsAddons.settings.disablePoi,
      disableMinor: browsingSettingsAddons.settings.disableMinor,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      ...queryOptions,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items, loadingPreferences, hiddenCount } = useApplyHiddenPreferences({
    type: 'images',
    data: flatData,
    showHidden: !!filters.hidden,
    disabled: !applyHiddenPreferences,
    isRefetching: rest.isRefetching,
  });

  return {
    data,
    flatData,
    images: items,
    removedImages: hiddenCount,
    fetchedImages: flatData?.length,
    isLoading: isLoading || loadingPreferences,
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
      confirmProps: { color: 'red', loading: reportCsamImage.isLoading },
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
