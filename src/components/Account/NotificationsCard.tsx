import { Card, Center, Loader, Stack, Switch, Title } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { trpc } from '~/utils/trpc';

export function NotificationsCard() {
  const currentUser = useCurrentUser();

  // Get these from our API
  const { data: settings = [], isLoading: loadingSettings } =
    trpc.notification.getSettings.useQuery(undefined, {
      cacheTime: Infinity,
      staleTime: Infinity,
    });

  const { data: userNotificationSettings = [], isLoading } =
    trpc.user.getNotificationSettings.useQuery();
  const disabledSettings = userNotificationSettings.map((userSetting) => userSetting.type);

  const updateNotificationSettingMutation = trpc.notification.updateUserSettings.useMutation();
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
        {loadingSettings ? (
          <Center>
            <Loader />
          </Center>
        ) : (
          settings.map(({ type, label }) => (
            <Switch
              key={type}
              label={label}
              defaultChecked={!disabledSettings.includes(type)}
              disabled={isLoading}
              onChange={({ target }) =>
                handleUpdateNotificationSetting({ toggle: target.checked, type: type })
              }
            />
          ))
        )}
      </Stack>
    </Card>
  );
}
