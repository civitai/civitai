import { Card, Divider, Stack, Title, Group, Text, Checkbox } from '@mantine/core';
import { IconBellOff } from '@tabler/icons-react';
import React from 'react';
import { NewsletterToggle } from '~/components/Account/NewsletterToggle';
import { useNotificationSettings } from '~/components/Notifications/useNotificationSettings';
import { SkeletonSwitch } from '~/components/SkeletonSwitch/SkeletonSwitch';
import {
  isOptInNotification,
  notificationCategoryTypes,
  notificationTypes,
} from '~/server/notifications/utils.notifications';
import { showSuccessNotification } from '~/utils/notifications';

import { trpc } from '~/utils/trpc';

export default function NotificationsCard() {
  const queryUtils = trpc.useUtils();

  const { hasNotifications, hasCategory, notificationSettings, isLoading } =
    useNotificationSettings();

  const updateNotificationSettingMutation = trpc.notification.updateUserSettings.useMutation({
    async onMutate({ toggle, type }) {
      await queryUtils.user.getNotificationSettings.cancel();

      const prevUserSettings = queryUtils.user.getNotificationSettings.getData() ?? [];
      const withRow = prevUserSettings.map((x) => x.type);
      const latestSetting =
        prevUserSettings.length > 0 ? prevUserSettings[prevUserSettings.length - 1] : { id: 0 };

      // Mirror the split the toggle handler makes: for an opt-in type the row means subscribed, so
      // the same `toggle` adds a row where it removes one for everything else. Guessing a single
      // direction here made the checkbox flicker to the wrong state until the refetch landed.
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
  const toggleAll = (toggle: boolean) => {
    updateNotificationSettingMutation.mutate({ toggle, type: notificationTypes });
  };
  const toggleCategory = (category: string, toggle: boolean) => {
    // Same exclusion `notificationTypes` makes for toggleAll — a category switch must not decide an
    // opt-in subscription on the user's behalf in either direction.
    const categoryTypes = notificationCategoryTypes[category]
      ?.filter((x) => !x.optIn)
      .map((x) => x.type);
    if (!categoryTypes?.length) return;

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
            <Group justify="space-between">
              <Text fw={500}>On-site Notifications</Text>
              <SkeletonSwitch
                loading={isLoading}
                checked={hasNotifications ?? false}
                onChange={(e) => toggleAll(e.target.checked)}
              />
            </Group>
          </Card.Section>
          {!hasNotifications ? (
            <Group wrap="nowrap" mt="xs" pb="sm">
              <IconBellOff size={24} strokeWidth={2} />
              <Text style={{ lineHeight: 1.3 }}>
                {`All non-essential notifications are turned off`}
              </Text>
            </Group>
          ) : (
            <>
              {Object.entries(notificationCategoryTypes).map(([category, settings]) => (
                <React.Fragment key={category}>
                  <Card.Section withBorder inheritPadding py="xs">
                    <Group justify="space-between">
                      <Text fw={500}>{category} Notifications</Text>
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
                          <Checkbox
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
