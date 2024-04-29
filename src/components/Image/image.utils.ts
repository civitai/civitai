import { MediaType, MetricTimeframe, ReviewReactions } from '@prisma/client';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { FilterKeys, useFiltersContext } from '~/providers/FiltersProvider';
import { ImageSort } from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { booleanString, numericString, numericStringArray } from '~/utils/zod-helpers';
import { isEqual } from 'lodash-es';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { showNotification, hideNotification } from '@mantine/notifications';
import { closeModal, openConfirmModal } from '@mantine/modals';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';

export const imagesQueryParamSchema = z
  .object({
    modelId: numericString(),
    modelVersionId: numericString(),
    postId: numericString(),
    collectionId: numericString(),
    username: z.coerce.string().transform(postgresSlugify),
    prioritizedUserIds: numericStringArray(),
    limit: numericString(),
    period: z.nativeEnum(MetricTimeframe),
    periodMode: periodModeSchema,
    sort: z.nativeEnum(ImageSort),
    tags: numericStringArray(),
    view: z.enum(['categories', 'feed']),
    excludeCrossPosts: z.boolean(),
    reactions: z.preprocess(
      (val) => (Array.isArray(val) ? val : [val]),
      z.array(z.nativeEnum(ReviewReactions))
    ),
    types: z
      .union([z.array(z.nativeEnum(MediaType)), z.nativeEnum(MediaType)])
      .transform((val) => (Array.isArray(val) ? val : [val]))
      .optional(),
    withMeta: booleanString(),
    section: z.enum(['images', 'reactions']),
    hidden: booleanString(),
    followed: booleanString(),
    fromPlatform: booleanString(),
    notPublished: booleanString(),
  })
  .partial();

export const useImageQueryParams = () => useZodRouteParams(imagesQueryParamSchema);

export const useImageFilters = (type: FilterKeys<'images' | 'modelImages' | 'videos'>) => {
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
  filters?: Partial<GetInfiniteImagesInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean; applyHiddenPreferences?: boolean }
) => {
  const { applyHiddenPreferences = true, ...queryOptions } = options ?? {};
  filters ??= {};
  const { data, isLoading, ...rest } = trpc.image.getInfinite.useInfiniteQuery(
    { include: ['cosmetics'], ...filters },
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
        disallowClose: true,
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
