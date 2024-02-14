import { useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import { GetUserNotificationsSchema } from '~/server/schema/notification.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { notificationCategoryTypes } from '~/server/notifications/utils.notifications';

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

  return trpc.notification.markRead.useMutation({
    async onSuccess() {
      await queryUtils.user.checkNotifications.invalidate();
      await queryUtils.notification.getAllByUser.invalidate();
    },
  });
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
