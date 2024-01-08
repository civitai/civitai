import { ImageIngestionStatus, MediaType, MetricTimeframe, ReviewReactions } from '@prisma/client';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { FilterKeys, useFiltersContext } from '~/providers/FiltersProvider';
import { ImageSort } from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import { GetImagesByCategoryInput, GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { booleanString, numericString, numericStringArray } from '~/utils/zod-helpers';
import { isEqual } from 'lodash-es';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { showNotification, hideNotification } from '@mantine/notifications';
import { closeModal, openConfirmModal } from '@mantine/modals';

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
    hidden: z.coerce.boolean(),
    followed: z.coerce.boolean(),
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
    filters,
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
  // const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.image.getInfinite.useInfiniteQuery(
    { ...filters },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      ...queryOptions,
    }
  );

  const currentUser = useCurrentUser();
  const {
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingHidden,
  } = useHiddenPreferencesContext();

  const { images, fetchedImages, removedImages } = useMemo(() => {
    // TODO - fetch user reactions for images separately
    if (loadingHidden)
      return {
        images: [],
        fetchedImages: 0,
        removedImages: 0,
      };

    const arr = data?.pages.flatMap((x) => x.items) ?? [];
    const filtered = applyHiddenPreferences
      ? arr.filter((x) => {
          if (x.user.id === currentUser?.id) return true;
          if (x.ingestion !== ImageIngestionStatus.Scanned) return false;
          if (hiddenImages.get(x.id) && !filters?.hidden) return false;
          if (hiddenUsers.get(x.user.id)) return false;
          for (const tag of x.tagIds ?? []) if (hiddenTags.get(tag)) return false;
          return true;
        })
      : arr;

    return {
      images: filtered,
      fetchedImages: arr.length,
      removedImages: arr.length - filtered.length,
    };
  }, [
    data,
    currentUser,
    hiddenImages,
    hiddenTags,
    hiddenUsers,
    loadingHidden,
    filters?.hidden,
    applyHiddenPreferences,
  ]);

  return { data, images, removedImages, fetchedImages, ...rest };
};

export const useQueryImageCategories = (
  filters?: Partial<GetImagesByCategoryInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  // const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.image.getImagesByCategory.useInfiniteQuery(
    { ...filters },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      keepPreviousData: true,
      ...options,
    }
  );

  const categories = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, categories, ...rest };
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
