import { trpc } from '~/utils/trpc';
import type { RouterOutput } from '~/types/router';
import type { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

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

  return { submitItem, updateItem, archiveItem, updateSettings, reviewItem };
};
