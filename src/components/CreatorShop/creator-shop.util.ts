import { useEffect, useMemo, useState } from 'react';
import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';
import type { GetPublicShopItemsInput } from '~/server/schema/creator-shop.schema';
import type { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

// Matches getEarlyAccessPricesSchema.modelVersionIds.max(200).
const EARLY_ACCESS_PRICE_BATCH = 200;

export type CreatorShopData = RouterOutput['creatorShop']['getShop'];
export type CreatorShopItem = CreatorShopData['cosmetics'][number];
export type CreatorShopManageItem = RouterOutput['creatorShop']['getManageItems'][number];

export const useQueryCreatorShop = (userId?: number) => {
  const { data, ...rest } = trpc.creatorShop.getShop.useQuery(
    { userId: userId as number },
    { enabled: !!userId }
  );
  return { shop: data, ...rest };
};

// `userId` is only honored for moderators (enforced server-side); owners omit it.
export const useQueryCreatorShopManage = (enabled = true, userId?: number) => {
  const { data = [], ...rest } = trpc.creatorShop.getManageItems.useQuery({ userId }, { enabled });
  return { items: data, ...rest };
};

export const useQueryCreatorShopSettings = (enabled = true) => {
  const { data, ...rest } = trpc.creatorShop.getSettings.useQuery(undefined, { enabled });
  return { settings: data, ...rest };
};

// Other creators' shop items available to resell (cross-creator selling).
export type CreatorShopPublicShopItem =
  RouterOutput['creatorShop']['getPublicShopItems']['items'][number];
export const useQueryPublicShopItems = (filters: Partial<GetPublicShopItemsInput> = {}) => {
  const { data, ...rest } = trpc.creatorShop.getPublicShopItems.useInfiniteQuery(filters, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
  const items = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);
  return { items, ...rest };
};

// Early Access download prices for the Models section, keyed by model version id.
// As the infinite feed grows we only request ids we haven't resolved yet (in
// batches), instead of re-fetching the whole growing set on every page.
export const useQueryEarlyAccessPrices = (modelVersionIds: number[]) => {
  const [prices, setPrices] = useState<Record<number, number>>({});
  // Every id we've already asked the server about (priced or not) so we never
  // re-request it — the response omits unpriced ids, so a price map alone can't
  // distinguish "no price" from "not yet fetched".
  const [resolved, setResolved] = useState<Set<number>>(() => new Set());

  const requestedIds = useMemo(
    () => modelVersionIds.filter((id) => !resolved.has(id)).slice(0, EARLY_ACCESS_PRICE_BATCH),
    [modelVersionIds, resolved]
  );

  const { data, dataUpdatedAt } = trpc.creatorShop.getEarlyAccessPrices.useQuery(
    { modelVersionIds: requestedIds },
    { enabled: requestedIds.length > 0 }
  );

  useEffect(() => {
    if (!data) return;
    setPrices((prev) => ({ ...prev, ...data }));
    // `dataUpdatedAt` only advances on a completed fetch, whose query key is the
    // current `requestedIds`, so this closure always matches the response.
    setResolved((prev) => {
      const next = new Set(prev);
      for (const id of requestedIds) next.add(id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt]);

  return prices;
};

export const useQueryCreatorShopReviewQueue = ({
  status,
  username,
  enabled = true,
}: {
  status?: CosmeticShopItemStatus | undefined;
  username?: string;
  enabled?: boolean;
} = {}) =>
  trpc.creatorShop.getReviewQueue.useInfiniteQuery(
    { limit: 20, status, username: username?.trim() || undefined },
    { enabled, getNextPageParam: (lastPage) => lastPage.nextCursor }
  );

export const useMutateCreatorShop = () => {
  const queryUtils = trpc.useUtils();

  const onError = (title: string) => (error: { message: string }) =>
    showErrorNotification({ title, error: new Error(error.message) });

  const submitItem = trpc.creatorShop.submitItem.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getManageItems.invalidate();
      showSuccessNotification({ message: 'Item submitted for review' });
    },
    onError: onError('Failed to submit item'),
  });

  const updateItem = trpc.creatorShop.updateItem.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getManageItems.invalidate();
      showSuccessNotification({ message: 'Item updated' });
    },
    onError: onError('Failed to update item'),
  });

  const archiveItem = trpc.creatorShop.archiveItem.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getManageItems.invalidate();
    },
    onError: onError('Failed to archive item'),
  });

  const unarchiveItem = trpc.creatorShop.unarchiveItem.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getManageItems.invalidate();
    },
    onError: onError('Failed to restore item'),
  });

  const addResoldItem = trpc.creatorShop.addResoldItem.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getSettings.invalidate();
      await queryUtils.creatorShop.getShop.invalidate();
      showSuccessNotification({ message: 'Added to your shop' });
    },
    onError: onError('Failed to add item'),
  });

  const removeResoldItem = trpc.creatorShop.removeResoldItem.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getSettings.invalidate();
      await queryUtils.creatorShop.getShop.invalidate();
    },
    onError: onError('Failed to remove item'),
  });

  const updateSettings = trpc.creatorShop.updateSettings.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getSettings.invalidate();
      showSuccessNotification({ message: 'Shop settings saved' });
    },
    onError: onError('Failed to save settings'),
  });

  const reviewItem = trpc.creatorShop.reviewItem.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getReviewQueue.invalidate();
    },
    onError: onError('Failed to review item'),
  });

  return {
    submitItem,
    updateItem,
    archiveItem,
    unarchiveItem,
    addResoldItem,
    removeResoldItem,
    updateSettings,
    reviewItem,
  };
};
