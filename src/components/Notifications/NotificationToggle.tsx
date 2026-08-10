import { useMemo } from 'react';
import { notificationCategoryTypes } from '~/server/notifications/utils.notifications';
import {
  useNotificationSettings,
  useToggleNotificationSetting,
} from '~/components/Notifications/useNotificationSettings';

// could this be lazy loaded?
export function NotificationToggle({
  type,
  children,
}: {
  type: string;
  children: (props: {
    onToggle: () => void;
    isLoading: boolean;
    displayName: string;
    isEnabled: boolean;
  }) => JSX.Element | null;
}) {
  const { notificationSettings, isLoading } = useNotificationSettings();
  const updateNotificationSettingMutation = useToggleNotificationSetting();

  const notification = useMemo(() => {
    return Object.values(notificationCategoryTypes)
      .flat()
      .find((x) => x.type === type);
  }, [type]);

  if (!notification || isLoading) {
    return null;
  }

  const isEnabled = !!notificationSettings[type];

  const onToggle = () => {
    updateNotificationSettingMutation.mutate({ toggle: !isEnabled, type: [type] });
  };

  return children({
    onToggle,
    isLoading: updateNotificationSettingMutation.isPending,
    displayName: notification.displayName,
    isEnabled,
  });
}
