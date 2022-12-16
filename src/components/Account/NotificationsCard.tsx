import { Card, Stack, Switch, Title } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getNotificationTypes } from '~/server/notifications/utils.notifications';
import { showSuccessNotification } from '~/utils/notifications';

import { trpc } from '~/utils/trpc';

const settings = Object.entries(getNotificationTypes()).map(([type, label]) => ({ type, label }));

export function NotificationsCard() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { data: userNotificationSettings = [], isLoading } =
    trpc.user.getNotificationSettings.useQuery();
  const disabledSettings = userNotificationSettings.map((userSetting) => userSetting.type);

  const updateNotificationSettingMutation = trpc.notification.updateUserSettings.useMutation({
    async onMutate({ toggle, type, userId }) {
      await queryUtils.user.getNotificationSettings.cancel();

      const prevUserSettings = queryUtils.user.getNotificationSettings.getData() ?? [];
      const latestSetting =
        prevUserSettings.length > 0 ? prevUserSettings[prevUserSettings.length - 1] : { id: 0 };
      const newSetting = { ...latestSetting, type, userId, disabledAt: new Date() };

      queryUtils.user.getNotificationSettings.setData(undefined, (old = []) =>
        toggle ? old?.filter((setting) => setting.type !== type) : [...old, newSetting]
      );

      return { prevUserSettings };
    },
    onSuccess() {
      showSuccessNotification({ message: 'User profile updated' });
    },
    onError(_error, _variables, context) {
      queryUtils.user.getNotificationSettings.setData(undefined, context?.prevUserSettings);
    },
    async onSettled() {
      await queryUtils.user.getNotificationSettings.invalidate();
    },
  });
  const handleUpdateNotificationSetting = ({ toggle, type }: { toggle: boolean; type: string }) => {
    if (currentUser)
      updateNotificationSettingMutation.mutate({ toggle, type, userId: currentUser.id });
  };

  return (
    <Card withBorder>
      <Stack>
        <Title id="notification-settings" order={2}>
          Notifications Settings
        </Title>
        {settings.map(({ type, label }) => (
          <Switch
            key={type}
            label={label}
            checked={!disabledSettings.includes(type)}
            disabled={isLoading}
            onChange={({ target }) =>
              handleUpdateNotificationSetting({ toggle: target.checked, type: type })
            }
          />
        ))}
      </Stack>
    </Card>
  );
}
