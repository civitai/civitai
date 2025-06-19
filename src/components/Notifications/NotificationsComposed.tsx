import {
  Center,
  CloseButton,
  Group,
  Loader,
  Paper,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconListCheck, IconSearch, IconSettings, IconX } from '@tabler/icons-react';
import React, { forwardRef, useMemo, useState } from 'react';
import { dismissAnnouncements } from '~/components/Announcements/announcements.utils';
import { AnnouncementsList } from '~/components/Announcements/AnnouncementsList';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink } from '~/components/NextLink/NextLink';

import { NotificationList } from '~/components/Notifications/NotificationList';
import {
  getCategoryDisplayName,
  useGetAnnouncementsAsNotifications,
  useMarkReadNotification,
  useQueryNotifications,
} from '~/components/Notifications/notifications.utils';
import { NotificationTabs } from '~/components/Notifications/NotificationTabs';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { NotificationCategory } from '~/server/common/enums';

export const NotificationsComposed = forwardRef<HTMLDivElement, { onClose?: () => void }>(
  ({ onClose }, ref) => {
    const [selectedTab, setSelectedTab] = useState<string | null>(null);
    const [searchText, setSearchText] = useState<string>('');
    const [hideRead, setHideRead] = useLocalStorage<boolean>({
      key: 'notifications-hide-read',
      defaultValue: false,
    });
    const selectedCategory = Object.values(NotificationCategory).find(
      (category) => category === selectedTab
    );

    const {
      notifications: data,
      isLoading: loadingNotifications,
      hasNextPage,
      fetchNextPage,
      isRefetching,
    } = useQueryNotifications(
      {
        limit: 30,
        category: selectedCategory,
        unread: hideRead ? true : undefined,
      },
      { keepPreviousData: false }
    );

    const announcements = useGetAnnouncementsAsNotifications({ hideRead });
    const notifications = useMemo(() => {
      return !selectedTab
        ? data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        : data;
    }, [data, selectedTab]);

    const readNotificationMutation = useMarkReadNotification();
    const categoryName = !selectedTab ? 'all' : getCategoryDisplayName(selectedTab);

    function handleMarkAsRead() {
      if (selectedTab === 'announcements') dismissAnnouncements(announcements.map((x) => x.id));
      if (selectedTab !== 'announcements')
        readNotificationMutation.mutate({
          all: true,
          category: selectedCategory,
        });
    }

    return (
      <>
        <div className="flex flex-col gap-4 p-4">
          <Group justify="space-between">
            <Title className="text-[21px] sm:text-[34px]" order={1}>
              Notifications
            </Title>
            <Group gap={8}>
              <Switch
                label="Hide Read"
                labelPosition="left"
                checked={hideRead}
                onChange={(e) => setHideRead(e.currentTarget.checked)}
              />
              <Tooltip label={`Mark ${categoryName} as read`} position="bottom">
                <LegacyActionIcon size="lg" onClick={handleMarkAsRead}>
                  <IconListCheck />
                </LegacyActionIcon>
              </Tooltip>
              <Tooltip label="Notification settings" position="bottom">
                <LegacyActionIcon
                  component={NextLink}
                  size="lg"
                  href="/user/account#notification-settings"
                >
                  <IconSettings />
                </LegacyActionIcon>
              </Tooltip>
              {onClose && <CloseButton size="lg" onClick={onClose} />}
            </Group>
          </Group>
          <NotificationTabs
            onTabChange={(value) => setSelectedTab(value as NotificationCategory | null)}
          />
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder="Filter by message..."
            value={searchText}
            maxLength={150}
            disabled={!notifications || notifications.length === 0}
            onChange={(event) => setSearchText(event.currentTarget.value)}
            rightSection={
              <LegacyActionIcon onClick={() => setSearchText('')} disabled={!searchText.length}>
                <IconX size={16} />
              </LegacyActionIcon>
            }
          />
        </div>
        <ScrollArea className="px-4 pb-4" scrollRestore={{ key: selectedTab ?? 'all' }}>
          {selectedTab === 'announcements' ? (
            <AnnouncementsList />
          ) : (
            <>
              {loadingNotifications ? (
                <Center p="sm">
                  <Loader />
                </Center>
              ) : notifications && notifications.length > 0 ? (
                <Paper radius="md" withBorder>
                  <NotificationList
                    items={notifications}
                    searchText={searchText}
                    onItemClick={(notification, keepOpened) => {
                      if (notification.type === 'announcement' && !notification.read) {
                        dismissAnnouncements(notification.id);
                      } else if (!notification.read)
                        readNotificationMutation.mutate({
                          id: notification.id,
                          category: notification.category,
                        });
                      if (!keepOpened && notification.details.url) onClose?.();
                    }}
                  />
                  {hasNextPage && (
                    <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
                      <Center p="xl" style={{ height: 36 }} mt="md">
                        <Loader />
                      </Center>
                    </InViewLoader>
                  )}
                </Paper>
              ) : (
                <Center p="sm">
                  <Text>All caught up! Nothing to see here</Text>
                </Center>
              )}
            </>
          )}
        </ScrollArea>
      </>
    );
  }
);

NotificationsComposed.displayName = 'NotificationsComposed';
