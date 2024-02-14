import { Card, Divider, Stack, Switch, Title, Group, Text } from '@mantine/core';
import { IconBellOff } from '@tabler/icons-react';
import React from 'react';
import { useMemo } from 'react';
import { NewsletterToggle } from '~/components/Account/NewsletterToggle';
import { SkeletonSwitch } from '~/components/SkeletonSwitch/SkeletonSwitch';
import {
  notificationCategoryTypes,
  notificationTypes,
} from '~/server/notifications/utils.notifications';
import { showSuccessNotification } from '~/utils/notifications';

import { trpc } from '~/utils/trpc';

export function NotificationsCard() {
  const queryUtils = trpc.useContext();

  const { data: userNotificationSettings = [], isLoading } =
    trpc.user.getNotificationSettings.useQuery();
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
  const toggleAll = (toggle: boolean) => {
    updateNotificationSettingMutation.mutate({ toggle, type: notificationTypes });
  };
  const toggleCategory = (category: string, toggle: boolean) => {
    const categoryTypes = notificationCategoryTypes[category]?.map((x) => x.type);
    if (!categoryTypes) return;

    updateNotificationSettingMutation.mutate({
      toggle,
      type: categoryTypes,
    });
  };
  const toggleType = (type: string, toggle: boolean) => {
    updateNotificationSettingMutation.mutate({ toggle, type: [type] });
  };

  return (
    <Card withBorder>
      <Stack>
        <Title id="notification-settings" order={2}>
          Notifications Settings
        </Title>
        <Card withBorder pb={0}>
          <Card.Section withBorder inheritPadding py="xs">
            <Group position="apart">
              <Text weight={500}>On-site Notifications</Text>
              <SkeletonSwitch
                loading={isLoading}
                checked={hasNotifications ?? false}
                onChange={(e) => toggleAll(e.target.checked)}
              />
            </Group>
          </Card.Section>
          {!hasNotifications ? (
            <Group noWrap mt="xs" pb="sm">
              <IconBellOff size={24} strokeWidth={2} />
              <Text sx={{ lineHeight: 1.3 }}>
                {`All non-essential notifications are turned off`}
              </Text>
            </Group>
          ) : (
            <>
              {Object.entries(notificationCategoryTypes).map(([category, settings]) => (
                <React.Fragment key={category}>
                  <Card.Section withBorder inheritPadding py="xs">
                    <Group position="apart">
                      <Text weight={500}>{category} Notifications</Text>
                      <SkeletonSwitch
                        loading={isLoading}
                        checked={hasCategory[category]}
                        onChange={(e) => toggleCategory(category, e.target.checked)}
                      />
                    </Group>
                  </Card.Section>
                  {hasCategory[category] && (
                    <Card.Section inheritPadding py="md">
                      <Stack>
                        {settings.map(({ type, displayName }) => (
                          <Switch
                            key={type}
                            label={displayName}
                            checked={notificationSettings[type]}
                            disabled={isLoading}
                            onChange={(e) => toggleType(type, e.target.checked)}
                          />
                        ))}
                      </Stack>
                    </Card.Section>
                  )}
                </React.Fragment>
              ))}
            </>
          )}
        </Card>
        <Divider label="Email Notifications" />
        <NewsletterToggle />
      </Stack>
    </Card>
  );
}
