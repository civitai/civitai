import {
  ActionIcon,
  Center,
  CloseButton,
  Drawer,
  Group,
  Indicator,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { useClickOutside } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { NotificationCategory } from '@prisma/client';
import { IconBell, IconListCheck, IconSettings } from '@tabler/icons-react';
import { useState } from 'react';

import { InViewLoader } from '~/components/InView/InViewLoader';
import { NotificationList } from '~/components/Notifications/NotificationList';
import {
  getCategoryDisplayName,
  useMarkReadNotification,
  useQueryNotifications,
  useQueryNotificationsCount,
} from '~/components/Notifications/notifications.utils';
import { NotificationTabs } from '~/components/Notifications/NotificationTabs';
import { useIsMobile } from '~/hooks/useIsMobile';

export function NotificationBell() {
  const mobile = useIsMobile();

  const [opened, setOpened] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<NotificationCategory | null>(null);
  const [toggle, setToggle] = useState<HTMLDivElement | null>(null);
  const [drawer, setDrawer] = useState<HTMLDivElement | null>(null);
  useClickOutside(() => setOpened(false), null, [toggle, drawer]);

  const count = useQueryNotificationsCount();
  const {
    notifications,
    isLoading: loadingNotifications,
    hasNextPage,
    fetchNextPage,
    isRefetching,
  } = useQueryNotifications({ limit: 20, category: selectedCategory }, { enabled: opened });

  const readNotificationMutation = useMarkReadNotification();
  const categoryName = !selectedCategory ? 'all' : getCategoryDisplayName(selectedCategory);

  return (
    <>
      <div onClick={() => setOpened((val) => !val)} ref={setToggle} style={{ height: '28px' }}>
        <Indicator
          color="red"
          overflowCount={99}
          label={count.all}
          size={16}
          offset={4}
          showZero={false}
          dot={false}
          withBorder
          inline
          styles={{
            indicator: {
              height: '20px !important',
              cursor: 'pointer',
              '> span': { marginBottom: '2px' },
            },
            common: {
              fontWeight: 500,
              fontSize: 12,
            },
          }}
        >
          <ActionIcon>
            <IconBell />
          </ActionIcon>
        </Indicator>
      </div>
      <Drawer
        position={mobile ? 'bottom' : 'right'}
        size={mobile ? '100dvh' : '700px'}
        styles={(theme) => ({
          root: {
            [theme.fn.largerThan('xs')]: {
              top: 'var(--mantine-header-height)',
              height: `calc(100% - var(--mantine-header-height))`,
            },
          },
          drawer: {
            [theme.fn.largerThan('xs')]: {
              top: 'var(--mantine-header-height)',
              height: `calc(100% - var(--mantine-header-height))`,
            },
          },
        })}
        shadow="lg"
        opened={opened}
        onClose={() => setOpened(false)}
        closeOnClickOutside={false}
        withCloseButton={false}
        withOverlay={mobile}
        withinPortal
      >
        <Stack spacing="xl" h="100%" p="md" ref={setDrawer}>
          <Group position="apart">
            <Text size="xl" weight="bold">
              Notifications
            </Text>
            <Group spacing={8}>
              <Tooltip label={`Mark ${categoryName} as read`} position="bottom">
                <ActionIcon
                  size="lg"
                  onClick={() =>
                    readNotificationMutation.mutate({
                      all: true,
                      category: selectedCategory,
                    })
                  }
                >
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
            <Paper radius="md" withBorder sx={{ overflow: 'hidden' }} component={ScrollArea}>
              <NotificationList
                items={notifications}
                onItemClick={(notification, keepOpened) => {
                  if (!notification.read)
                    readNotificationMutation.mutate({
                      id: notification.id,
                      category: notification.category,
                    });
                  setOpened(keepOpened);
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
        </Stack>
      </Drawer>
    </>
  );
}
