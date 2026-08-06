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
      for (const { type, optIn } of settings) {
        const hasRow = userNotificationSettings.some((setting) => setting.type === type);
        // A row means opted-out normally, but subscribed for an opt-in type.
        const isEnabled = optIn ? hasRow : !hasRow;
        notificationSettings[type] = isEnabled;
        // Opt-in types are excluded from the aggregates on purpose: they are not part of the
        // baseline every user starts with, so one shouldn't make the master switch read as "on" —
        // and the category tree is what renders the control for turning it back off.
        if (optIn) continue;
        if (!hasCategory[category] && isEnabled) hasCategory[category] = true;
        if (!hasNotifications && isEnabled) hasNotifications = true;
      }
    }
    return { hasNotifications, hasCategory, notificationSettings };
  }, [userNotificationSettings]);

  return { hasNotifications, hasCategory, notificationSettings, isLoading };
};
