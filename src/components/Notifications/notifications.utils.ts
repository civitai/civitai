import { InfiniteData, useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useCallback, useMemo } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { NotificationCategory, SignalMessages } from '~/server/common/enums';
import { notificationCategoryTypes } from '~/server/notifications/utils.notifications';
import { GetUserNotificationsSchema } from '~/server/schema/notification.schema';
import { NotificationGetAll, NotificationGetAllItem } from '~/types/router';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const categoryNameMap: Partial<Record<NotificationCategory, string>> = {
  [NotificationCategory.Comment]: 'Comments',
  [NotificationCategory.Milestone]: 'Milestones',
  [NotificationCategory.Update]: 'Updates',
  [NotificationCategory.Bounty]: 'Bounties',
  [NotificationCategory.Other]: 'Others',
};
export const getCategoryDisplayName = (category: NotificationCategory) =>
  categoryNameMap[category] ?? getDisplayName(category);

export const useQueryNotifications = (
  filters?: Partial<GetUserNotificationsSchema>,
  options?: { enabled?: boolean; keepPreviousData?: boolean }
) => {
  const { data, ...rest } = trpc.notification.getAllByUser.useInfiniteQuery(
    { limit: 100, ...filters },
    { getNextPageParam: (lastPage) => lastPage.nextCursor, keepPreviousData: true, ...options }
  );
  const notifications = useMemo(
    () => data?.pages.flatMap((page) => page.items) ?? [],
    [data?.pages]
  );

  return { data, notifications, ...rest };
};

export const useQueryNotificationsCount = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.user.checkNotifications.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });

  return isLoading || !data
    ? { all: 0, comment: 0, milestone: 0, update: 0, bounty: 0, other: 0 }
    : { ...data };
};

export const useMarkReadNotification = () => {
  const queryUtils = trpc.useUtils();
  const queryClient = useQueryClient();

  const mutation = trpc.notification.markRead.useMutation({
    async onMutate({ category, all, id }) {
      // Lower notification count
      const categoryStr = category?.toLowerCase();
      queryUtils.user.checkNotifications.cancel();
      queryUtils.user.checkNotifications.setData(undefined, (old) => {
        const newCounts: Record<string, number> = { ...old, all: old?.all ?? 0 };
        for (const key of Object.keys(newCounts)) {
          // TODO fix issue here with category clearing out all when it shouldnt
          const keyMatch = !categoryStr || key === categoryStr || key === 'all';
          if (keyMatch) {
            if (all) newCounts[key] = 0;
            else newCounts[key]--;
          }

          if (newCounts[key] < 0) newCounts[key] = 0;
        }
        return newCounts;
      });

      // Mark as read in notification feed
      const queryKey = getQueryKey(trpc.notification.getAllByUser);
      queryClient.setQueriesData<InfiniteData<NotificationGetAll>>(
        { queryKey, exact: false },
        produce((old) => {
          if (!old) return;

          for (const page of old?.pages ?? []) {
            if (all) {
              for (const item of page.items) {
                const categoryMatch = !categoryStr || item.category.toLowerCase() === categoryStr;
                if (categoryMatch) item.read = true;
              }
            } else if (id) {
              const item = page.items?.find((x) => x.id == id);
              if (item) item.read = true;
            }
          }
        })
      );
    },
  });

  return mutation;
};

export const useNotificationSettings = (enabled = true) => {
  const { data: userNotificationSettings = [], isLoading } =
    trpc.user.getNotificationSettings.useQuery(undefined, { enabled });
  const { hasNotifications, hasCategory, notificationSettings } = useMemo(() => {
    let hasNotifications = false;
    const notificationSettings: Record<string, boolean> = {};
    const hasCategory: Record<string, boolean> = {};
    for (const [category, settings] of Object.entries(notificationCategoryTypes)) {
      hasCategory[category] = false;
      for (const { type } of settings) {
        const isEnabled = !userNotificationSettings.some((setting) => setting.type === type);
        notificationSettings[type] = isEnabled;
        if (!hasCategory[category] && isEnabled) hasCategory[category] = true;
        if (!hasNotifications && isEnabled) hasNotifications = true;
      }
    }
    return { hasNotifications, hasCategory, notificationSettings };
  }, [userNotificationSettings]);

  return { hasNotifications, hasCategory, notificationSettings, isLoading };
};

export const useNotificationSignal = () => {
  const queryClient = useQueryClient();
  const queryUtils = trpc.useUtils();

  const onUpdate = useCallback(
    async (updated: NotificationGetAllItem) => {
      const queryKey = getQueryKey(trpc.notification.getAllByUser);

      // nb: this shouldn't run if "old" doesn't exist, but can't test that yet, and produce doesn't allow async
      let newUpdated = updated;
      try {
        const newUpdatedResp = await fetch('/api/notification/getDetails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(updated),
        });
        if (newUpdatedResp.ok) {
          const newUpdatedJson: NotificationGetAllItem = await newUpdatedResp.json();
          newUpdated = { ...newUpdated, ...newUpdatedJson };
        }
      } catch {}

      queryClient.setQueriesData<InfiniteData<NotificationGetAll>>(
        { queryKey, exact: false },
        produce((old) => {
          if (!old || !old.pages || !old.pages.length) return;
          const firstPage = old.pages[0];
          firstPage.items.unshift(newUpdated);
        })
      );

      queryUtils.user.checkNotifications.setData(undefined, (old) => {
        const newCounts: Record<string, number> = { ...old, all: old?.all ?? 0 };
        newCounts[updated.category.toLowerCase()] =
          (newCounts[updated.category.toLowerCase()] ?? 0) + 1;
        newCounts['all']++;

        return newCounts;
      });
    },
    [queryClient, queryUtils]
  );

  useSignalConnection(SignalMessages.NotificationNew, onUpdate);
};
