import {
  ActionIcon,
  Center,
  CloseButton,
  Drawer,
  Group,
  Indicator,
  Loader,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { NotificationCategory } from '@prisma/client';
import { IconBell, IconListCheck, IconSettings } from '@tabler/icons-react';
import { useState } from 'react';

import { InViewLoader } from '~/components/InView/InViewLoader';
import { NotificationList } from '~/components/Notifications/NotificationList';
import { NotificationTabs } from '~/components/Notifications/NotificationTabs';
import {
  useMarkReadNotification,
  useQueryNotifications,
  useQueryNotificationsCount,
} from '~/components/Notifications/notifications.utils';
import { useIsMobile } from '~/hooks/useIsMobile';

export function NotificationBell() {
  const mobile = useIsMobile();

  const [opened, setOpened] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<NotificationCategory | null>(null);

  const count = useQueryNotificationsCount();
  const {
    notifications,
    isLoading: loadingNotifications,
    hasNextPage,
    fetchNextPage,
    isRefetching,
  } = useQueryNotifications({ limit: 20, category: selectedCategory }, { enabled: opened });

  const readNotificationMutation = useMarkReadNotification();
  const handleMarkAsRead = ({ id, all }: { id?: string; all?: boolean }) => {
    readNotificationMutation.mutate({ id, all });
  };

  return (
    <>
      <Indicator
        color="red"
        overflowCount={999}
        label={count.all}
        size={16}
        offset={2}
        showZero={false}
        dot={false}
        inline
      >
        <ActionIcon onClick={() => setOpened((val) => !val)}>
          <IconBell />
        </ActionIcon>
      </Indicator>
      <Drawer
        position={mobile ? 'bottom' : 'right'}
        size={mobile ? 'calc(100dvh - var(--mantine-header-height))' : '700px'}
        shadow="lg"
        opened={opened}
        onClose={() => setOpened(false)}
        withCloseButton={false}
        withOverlay={mobile}
        withinPortal
      >
        <Stack spacing="xl" h="100%" pt="md" px="md">
          <Group position="apart">
            <Text size="xl" weight="bold">
              Notifications
            </Text>
            <Group spacing={8}>
              <Tooltip label="Mark all as read" position="bottom">
                <ActionIcon size="lg" onClick={() => handleMarkAsRead({ all: true })}>
                  <IconListCheck />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Notification settings" position="bottom">
                <ActionIcon
                  component={NextLink}
                  size="lg"
                  href="/user/account#notification-settings"
                >
                  <IconSettings />
                </ActionIcon>
              </Tooltip>
              <CloseButton size="lg" onClick={() => setOpened(false)} />
            </Group>
          </Group>
          <NotificationTabs
            onTabChange={(value: NotificationCategory | null) => setSelectedCategory(value)}
          />
          {loadingNotifications ? (
            <Center p="sm">
              <Loader />
            </Center>
          ) : notifications && notifications.length > 0 ? (
            <ScrollArea pb="md">
              <NotificationList
                items={notifications}
                onItemClick={(notification) => {
                  handleMarkAsRead({ id: notification.id });
                  setOpened(false);
                }}
                withDivider
              />
              {hasNextPage && (
                <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
                  <Center p="xl" sx={{ height: 36 }} mt="md">
                    <Loader />
                  </Center>
                </InViewLoader>
              )}
            </ScrollArea>
          ) : (
            <Center p="sm">
              <Text>All caught up! Nothing to see here</Text>
            </Center>
          )}
        </Stack>
      </Drawer>
    </>
  );
}
