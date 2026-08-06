import { Card, Divider, Stack, Title, Group, Text, Checkbox } from '@mantine/core';
import { IconBellOff } from '@tabler/icons-react';
import React from 'react';
import { NewsletterToggle } from '~/components/Account/NewsletterToggle';
import {
  useNotificationSettings,
  useToggleNotificationSetting,
} from '~/components/Notifications/useNotificationSettings';
import { SkeletonSwitch } from '~/components/SkeletonSwitch/SkeletonSwitch';
import {
  notificationCategoryTypes,
  notificationTypes,
  optInNotificationTypes,
} from '~/server/notifications/utils.notifications';

export default function NotificationsCard() {
  const { hasNotifications, hasCategory, notificationSettings, isLoading } =
    useNotificationSettings();

  const updateNotificationSettingMutation = useToggleNotificationSetting();

  // Asymmetric on purpose. Turning everything OFF must also unsubscribe opt-in types, or a user who
  // silences the site keeps receiving promos with no way back — the aggregates then hide the tree
  // that holds the only in-settings control. Turning everything ON must NOT subscribe them: nobody
  // reads "enable notifications" as "sign me up for shop promos". Opt-in stays a deliberate act.
  const toggleAll = (toggle: boolean) => {
    const type = toggle ? notificationTypes : [...notificationTypes, ...optInNotificationTypes];
    updateNotificationSettingMutation.mutate({ toggle, type });
  };
  const toggleCategory = (category: string, toggle: boolean) => {
    const categoryTypes = notificationCategoryTypes[category]
      ?.filter((x) => toggle === false || !x.optIn)
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
