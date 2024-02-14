import { useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import { GetUserNotificationsSchema } from '~/server/schema/notification.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { notificationCategoryTypes } from '~/server/notifications/utils.notifications';
import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';

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

  const mutation = trpc.notification.markRead.useMutation();

  function wrappedMutate({
    category,
    ...input
  }: Parameters<typeof mutation.mutate>[0] & { category?: string }) {
    // Lower notification count
    category = category?.toLowerCase();
    queryUtils.user.checkNotifications.cancel();
    queryUtils.user.checkNotifications.setData(undefined, (old) => {
      const newCounts: Record<string, number> = { ...old, all: old?.all ?? 0 };
      for (const key of Object.keys(newCounts)) {
        if (input.all) newCounts[key] = 0;
        else if (key === 'all' || key === category) newCounts[key]--;

        if (newCounts[key] < 0) newCounts[key] = 0;
      }
      return newCounts;
    });

    // Mark as read in notification feed
    const queryKey = getQueryKey(trpc.notification.getAllByUser);
    queryClient.setQueriesData(
      { queryKey, exact: false },
      produce((old: any) => {
        console.log(Object.keys(old), input.id);
        for (const page of old?.pages ?? []) {
          const item = page.items?.find((x: any) => x.id == input.id);
          if (item) item.read = true;
        }
      })
    );

    return mutation.mutate(input);
  }

  return {
    ...mutation,
    mutate: wrappedMutate,
  };
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
