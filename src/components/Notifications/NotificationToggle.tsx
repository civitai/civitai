import { useMemo } from 'react';
import { useNotificationSettings } from '~/components/Notifications/notifications.utils';
import {
  notificationCategoryTypes,
  notificationTypes,
} from '~/server/notifications/utils.notifications';
import { showSuccessNotification } from '~/utils/notifications';

import { trpc } from '~/utils/trpc';

export function NotificationToggle({
  type,
  children,
}: {
  type: (typeof notificationTypes)[number];
  children: (props: {
    onToggle: () => void;
    isLoading: boolean;
    displayName: string;
    isEnabled: boolean;
  }) => JSX.Element | null;
}) {
  const queryUtils = trpc.useUtils();

  const { notificationSettings, isLoading } = useNotificationSettings();

  const updateNotificationSettingMutation = trpc.notification.updateUserSettings.useMutation({
    async onMutate({ toggle, type }) {
      await queryUtils.user.getNotificationSettings.cancel();

      const prevUserSettings = queryUtils.user.getNotificationSettings.getData() ?? [];
      const currentlyDisabled = prevUserSettings.map((x) => x.type);
      const latestSetting =
        prevUserSettings.length > 0 ? prevUserSettings[prevUserSettings.length - 1] : { id: 0 };
      const newSettings = type
        .filter((t) => !currentlyDisabled.includes(t))
        .map((t) => ({ ...latestSetting, type: t, disabledAt: new Date() }));

      queryUtils.user.getNotificationSettings.setData(undefined, (old = []) =>
        toggle ? old?.filter((setting) => !type.includes(setting.type)) : [...old, ...newSettings]
      );

      return { prevUserSettings };
    },
    onSuccess() {
      showSuccessNotification({ message: 'User profile updated' });
    },
    onError(_error, _variables, context) {
      queryUtils.user.getNotificationSettings.setData(undefined, context?.prevUserSettings);
    },
  });

  const notification = useMemo(() => {
    return Object.values(notificationCategoryTypes)
      .flat()
      .find((x) => x.type === type);
  }, [type]);

  if (!notification || isLoading) {
    return null;
  }

  const isEnabled = notification.defaultDisabled
    ? !notificationSettings[type]
    : !!notificationSettings[type];

  const onToggle = () => {
    updateNotificationSettingMutation.mutate({ toggle: isEnabled, type: [type] });
  };

  return children({
    onToggle,
    isLoading: updateNotificationSettingMutation.isLoading,
    displayName: notification.displayName,
    isEnabled,
  });
}
