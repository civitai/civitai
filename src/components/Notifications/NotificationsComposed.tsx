import {
  ActionIcon,
  Center,
  CloseButton,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { IconListCheck, IconSettings } from '@tabler/icons-react';
import { forwardRef, useMemo, useState } from 'react';
import { AnnouncementsList } from '~/components/Announcements/AnnouncementsList';
import { useAnnouncementsContext } from '~/components/Announcements/AnnouncementsProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';

import { NotificationList } from '~/components/Notifications/NotificationList';
import {
  getCategoryDisplayName,
  useGetAnnouncementsAsNotifications,
  useMarkReadNotification,
  useQueryNotifications,
} from '~/components/Notifications/notifications.utils';
import { NotificationTabs } from '~/components/Notifications/NotificationTabs';
import { NotificationCategory } from '~/server/common/enums';

export const NotificationsComposed = forwardRef<HTMLDivElement, { onClose?: () => void }>(
  ({ onClose }, ref) => {
    const [selectedTab, setSelectedTab] = useState<string | null>(null);
    const [hideRead, setHideRead] = useLocalStorage<boolean>({
      key: 'notifications-hide-read',
      defaultValue: false,
    });
    const { dismissAll, dismiss } = useAnnouncementsContext();
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

    const announcements = useGetAnnouncementsAsNotifications();
    const notifications = useMemo(() => {
      return !selectedTab
        ? [...announcements, ...data].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        : data;
    }, [data, selectedTab, announcements]);

    const readNotificationMutation = useMarkReadNotification();
    const categoryName = !selectedTab ? 'all' : getCategoryDisplayName(selectedTab);

    function handleMarkAsRead() {
      if (selectedTab === 'announcements') dismissAll();
      else
        readNotificationMutation.mutate({
          all: true,
          category: selectedCategory,
        });
    }

    return (
      <Stack spacing="xl" ref={ref}>
        <Group position="apart">
          <Title order={1}>Notifications</Title>
          <Group spacing={8}>
            <Switch
              label="Hide Read"
              labelPosition="left"
              checked={hideRead}
              onChange={(e) => setHideRead(e.currentTarget.checked)}
            />
            <Tooltip label={`Mark ${categoryName} as read`} position="bottom">
              <ActionIcon size="lg" onClick={handleMarkAsRead}>
                <IconListCheck />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Notification settings" position="bottom">
              <ActionIcon component={NextLink} size="lg" href="/user/account#notification-settings">
                <IconSettings />
              </ActionIcon>
            </Tooltip>
            {onClose && <CloseButton size="lg" onClick={onClose} />}
          </Group>
        </Group>
        <NotificationTabs
          onTabChange={(value: NotificationCategory | null) => setSelectedTab(value)}
        />
        {selectedTab === 'announcements' ? (
          <AnnouncementsList />
        ) : (
          <>
            {loadingNotifications ? (
              <Center p="sm">
                <Loader />
              </Center>
            ) : notifications && notifications.length > 0 ? (
              <Paper radius="md" withBorder sx={{ overflow: 'hidden' }} component={ScrollArea}>
                <NotificationList
                  items={notifications}
                  onItemClick={(notification, keepOpened) => {
                    if (notification.type === 'announcement' && !notification.read) {
                      dismiss(notification.id);
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
                    <Center p="xl" sx={{ height: 36 }} mt="md">
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
      </Stack>
    );
  }
);

NotificationsComposed.displayName = 'NotificationsComposed';
