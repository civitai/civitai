import { Badge, Card, Checkbox, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconBellOff, IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useState } from 'react';

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

export function NotificationsPane() {
  const { hasNotifications, hasCategory, notificationSettings, isLoading } =
    useNotificationSettings();
  const updateNotificationSettingMutation = useToggleNotificationSetting();
  const [expanded, setExpanded] = useState<string | null>(null);

  // Asymmetric on purpose. Turning everything OFF must also unsubscribe opt-in types, or a user who
  // silences the site keeps receiving promos with no way back. Turning everything ON must NOT
  // subscribe them: nobody reads "enable notifications" as "sign me up for shop promos".
  const toggleAll = (toggle: boolean) => {
    const type = toggle ? notificationTypes : [...notificationTypes, ...optInNotificationTypes];
    updateNotificationSettingMutation.mutate({ toggle, type });
  };
  const toggleCategory = (category: string, toggle: boolean) => {
    const categoryTypes = notificationCategoryTypes[category]
      ?.filter((x) => toggle === false || !x.optIn)
      .map((x) => x.type);
    if (!categoryTypes?.length) return;
    updateNotificationSettingMutation.mutate({ toggle, type: categoryTypes });
  };
  const toggleType = (type: string, toggle: boolean) => {
    updateNotificationSettingMutation.mutate({ toggle, type: [type] });
  };

  return (
    <>
      <Card withBorder padding="lg">
        <Stack gap="sm">
          <Text fw={600}>Delivery</Text>
          <Group justify="space-between" wrap="nowrap">
            <div>
              <Text size="sm" fw={500}>
                On-site notifications
              </Text>
              <Text size="xs" c="dimmed">
                The bell in the header. Off silences every category below.
              </Text>
            </div>
            <SkeletonSwitch
              loading={isLoading}
              checked={hasNotifications ?? false}
              onChange={(e) => toggleAll(e.target.checked)}
            />
          </Group>
          <NewsletterToggle description="Product news and announcements, sent by email. Separate from the notifications below." />
        </Stack>
      </Card>

      {!hasNotifications ? (
        <Card withBorder padding="lg">
          <Group wrap="nowrap">
            <IconBellOff size={24} strokeWidth={2} />
            <Text style={{ lineHeight: 1.3 }}>All non-essential notifications are turned off</Text>
          </Group>
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {Object.entries(notificationCategoryTypes).map(([category, settings]) => {
            const isOpen = expanded === category;
            const enabled = settings.filter((x) => notificationSettings[x.type]).length;
            const categoryOn = hasCategory[category];

            return (
              <Card key={category} withBorder padding={0} className="overflow-hidden">
                <div
                  className={clsx(
                    'flex items-center gap-3 px-4 py-3',
                    isOpen && 'bg-gray-1 dark:bg-dark-5'
                  )}
                >
                  <UnstyledButton
                    className="flex flex-1 items-center gap-3"
                    onClick={() => setExpanded(isOpen ? null : category)}
                    aria-expanded={isOpen}
                  >
                    <IconChevronRight
                      size={16}
                      className={clsx('transition-transform', isOpen && 'rotate-90')}
                    />
                    <Text size="sm" fw={600} className="flex-1 text-left">
                      {category}
                    </Text>
                    <Badge size="sm" variant="light" color={enabled ? 'blue' : 'gray'}>
                      {enabled} of {settings.length}
                    </Badge>
                  </UnstyledButton>
                  <SkeletonSwitch
                    loading={isLoading}
                    checked={categoryOn}
                    onChange={(e) => toggleCategory(category, e.target.checked)}
                  />
                </div>

                {isOpen && (
                  <div className="flex flex-col gap-2.5 px-4 pb-4 pt-1">
                    {!categoryOn && (
                      <Text size="xs" c="dimmed">
                        This category is off, so none of these are sent.
                      </Text>
                    )}
                    {settings.map(({ type, displayName }) => (
                      <Checkbox
                        key={type}
                        label={displayName}
                        checked={notificationSettings[type]}
                        disabled={isLoading || !categoryOn}
                        onChange={(e) => toggleType(type, e.target.checked)}
                      />
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
