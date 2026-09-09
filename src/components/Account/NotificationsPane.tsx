import { Badge, Checkbox, Text, UnstyledButton } from '@mantine/core';
import type { Icon } from '@tabler/icons-react';
import {
  IconBellOff,
  IconBolt,
  IconChevronRight,
  IconCircleDot,
  IconMessage,
  IconPalette,
  IconRefresh,
  IconSettings,
  IconTargetArrow,
  IconTrophy,
  IconUserPlus,
} from '@tabler/icons-react';
import clsx from 'clsx';
import React, { useState } from 'react';

import { NewsletterToggle } from '~/components/Account/NewsletterToggle';
import { SettingRow, SettingsSection, SettingsStack } from '~/components/Account/SettingsLayout';
import {
  useNotificationSettings,
  useToggleNotificationSetting,
} from '~/components/Notifications/useNotificationSettings';
import { SkeletonSwitch } from '~/components/SkeletonSwitch/SkeletonSwitch';
import { NotificationCategory } from '~/server/common/enums';
import {
  notificationCategoryTypes,
  notificationTypes,
  optInNotificationTypes,
} from '~/server/notifications/utils.notifications';

const categoryIcons: Record<string, Icon> = {
  Comment: IconMessage,
  Update: IconRefresh,
  Creator: IconPalette,
  System: IconSettings,
  Milestone: IconTrophy,
  Bounty: IconTargetArrow,
  Referral: IconUserPlus,
  Buzz: IconBolt,
};

/**
 * `Other` is the catch-all bucket, so it belongs under the named categories however processor
 * registration happens to order them. Stable sort, so everything else keeps its order.
 */
const categoryEntries = Object.entries(notificationCategoryTypes).sort(
  ([a], [b]) => Number(a === NotificationCategory.Other) - Number(b === NotificationCategory.Other)
);

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
    <SettingsStack>
      <SettingsSection title="Delivery">
        <SettingRow
          label="On-site notifications"
          description="The bell in the header. Off silences every category below."
          control={
            <SkeletonSwitch
              loading={isLoading}
              checked={hasNotifications ?? false}
              onChange={(e) => toggleAll(e.target.checked)}
            />
          }
        />
        {/* Default branch is a raw Group with the switch first, which the section's Switch
            overrides can't reach. */}
        <NewsletterToggle>
          {({ subscribed, isLoading: newsletterLoading, setSubscribed }) => (
            <SettingRow
              label="Newsletter"
              description="Product news by email. Separate from the categories below."
              control={
                <SkeletonSwitch
                  loading={newsletterLoading}
                  checked={subscribed}
                  onChange={(e) => setSubscribed(e.target.checked)}
                />
              }
            />
          )}
        </NewsletterToggle>
      </SettingsSection>

      {!hasNotifications ? (
        <div className="flex items-center gap-3 rounded-md border border-gray-3 bg-white p-4 dark:border-dark-4 dark:bg-dark-6">
          <IconBellOff size={22} strokeWidth={2} className="shrink-0" />
          <Text size="sm">All non-essential notifications are turned off</Text>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {categoryEntries.map(([category, settings]) => {
            const isOpen = expanded === category;
            const enabled = settings.filter((x) => notificationSettings[x.type]).length;
            const categoryOn = hasCategory[category];
            const CategoryIcon = categoryIcons[category] ?? IconCircleDot;

            return (
              <div
                key={category}
                className="overflow-hidden rounded-md border border-gray-3 bg-white dark:border-dark-4 dark:bg-dark-6"
              >
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
                      className={clsx(
                        'shrink-0 text-gray-6 transition-transform dark:text-dark-2',
                        isOpen && 'rotate-90'
                      )}
                    />
                    <CategoryIcon size={18} className="shrink-0 text-gray-6 dark:text-dark-2" />
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
                  <div className="flex flex-col gap-2.5 p-4">
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
              </div>
            );
          })}
        </div>
      )}
    </SettingsStack>
  );
}
