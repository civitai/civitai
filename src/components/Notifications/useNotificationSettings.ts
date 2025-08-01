import { useMemo } from 'react';
import { notificationCategoryTypes } from '~/server/notifications/utils.notifications';
import { trpc } from '~/utils/trpc';

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
