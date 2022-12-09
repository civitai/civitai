import { Card, Stack, Switch, Title } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getNotificationTypes } from '~/server/notifications/utils.notifications';

import { trpc } from '~/utils/trpc';

const settings = Object.entries(getNotificationTypes()).map(([type, label]) => ({ type, label }));

export function NotificationsCard() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { data: userNotificationSettings = [], isLoading } =
    trpc.user.getNotificationSettings.useQuery();
  const disabledSettings = userNotificationSettings.map((userSetting) => userSetting.type);

  const updateNotificationSettingMutation = trpc.notification.updateUserSettings.useMutation({
    async onSuccess() {
      await queryUtils.user.getNotificationSettings.invalidate();
    },
  });
  const handleUpdateNotificationSetting = ({ toggle, type }: { toggle: boolean; type: string }) => {
    if (currentUser)
      updateNotificationSettingMutation.mutate({ toggle, type, userId: currentUser.id });
  };

  return (
    <Card>
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
