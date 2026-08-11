import { useMemo } from 'react';
import {
  isOptInNotification,
  notificationCategoryTypes,
} from '~/server/notifications/utils.notifications';
import { showSuccessNotification } from '~/utils/notifications';
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
        // Opt-in types don't feed the aggregates: they aren't part of the baseline every user
        // starts with, so a promo subscription shouldn't make the master switch read as "on".
        // Turning everything off therefore hides their checkbox — which is why `toggleAll`/
        // `toggleCategory` unsubscribe them on the way down rather than stranding the user.
        if (optIn) continue;
        if (!hasCategory[category] && isEnabled) hasCategory[category] = true;
        if (!hasNotifications && isEnabled) hasNotifications = true;
      }
    }
    return { hasNotifications, hasCategory, notificationSettings };
  }, [userNotificationSettings]);

  return { hasNotifications, hasCategory, notificationSettings, isLoading };
};

/**
 * Shared so the two callers can't drift apart on polarity. They previously hand-rolled the same
 * optimistic update, and updating one of them left the /shop bell writing correctly to the server
 * while its own cache patch no-opped — the control looked inert in both directions.
 */
export const useToggleNotificationSetting = () => {
  const queryUtils = trpc.useUtils();

  return trpc.notification.updateUserSettings.useMutation({
    async onMutate({ toggle, type }) {
      await queryUtils.user.getNotificationSettings.cancel();

      const prevUserSettings = queryUtils.user.getNotificationSettings.getData() ?? [];
      const withRow = prevUserSettings.map((x) => x.type);
      const latestSetting =
        prevUserSettings.length > 0 ? prevUserSettings[prevUserSettings.length - 1] : { id: 0 };

      // Mirrors the split the toggle handler makes: a row means subscribed for an opt-in type and
      // opted-out for everything else, so one `toggle` writes in both directions at once.
      const removing = type.filter((t) =>
        toggle ? !isOptInNotification(t) : isOptInNotification(t)
      );
      const adding = type
        .filter((t) => (toggle ? isOptInNotification(t) : !isOptInNotification(t)))
        .filter((t) => !withRow.includes(t))
        .map((t) => ({ ...latestSetting, type: t, disabledAt: new Date() }));

      queryUtils.user.getNotificationSettings.setData(undefined, (old = []) => [
        ...old.filter((setting) => !removing.includes(setting.type)),
        ...adding,
      ]);

      return { prevUserSettings };
    },
    onSuccess() {
      showSuccessNotification({ message: 'User profile updated' });
    },
    onError(_error, _variables, context) {
      queryUtils.user.getNotificationSettings.setData(undefined, context?.prevUserSettings);
    },
  });
};
