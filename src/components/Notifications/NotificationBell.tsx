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
import { IconBell, IconListCheck, IconSettings } from '@tabler/icons-react';
import { useState, useMemo } from 'react';

import { NotificationList } from '~/components/Notifications/NotificationList';
import { NotificationTabs } from '~/components/Notifications/NotificationTabs';
import { useQueryNotificationsCount } from '~/components/Notifications/notifications.utils';
import { trpc } from '~/utils/trpc';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NotificationCategory } from '@prisma/client';
import { useIsMobile } from '~/hooks/useIsMobile';

export function NotificationBell() {
  const queryUtils = trpc.useUtils();
  const mobile = useIsMobile();

  const [opened, setOpened] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<NotificationCategory | null>(null);

  const count = useQueryNotificationsCount();
  const {
    data,
    isLoading: loadingNotifications,
    hasNextPage,
    fetchNextPage,
    isRefetching,
  } = trpc.notification.getAllByUser.useInfiniteQuery(
    { limit: 5, category: selectedCategory },
    { enabled: opened, getNextPageParam: (lastPage) => lastPage.nextCursor, keepPreviousData: true }
  );
  const notifications = useMemo(
    () => data?.pages.flatMap((page) => page.items) ?? [],
    [data?.pages]
  );

  const readNotificationMutation = trpc.notification.markRead.useMutation({
    async onSuccess() {
      await queryUtils.user.checkNotifications.invalidate();
      await queryUtils.notification.getAllByUser.invalidate();
    },
  });
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
        padding="md"
        shadow="lg"
        opened={opened}
        onClose={() => setOpened(false)}
        withCloseButton={false}
        withOverlay={mobile}
        withinPortal
      >
        <Stack spacing="xl" h="100%">
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
            <ScrollArea>
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
    // <Popover
    //   position="bottom-end"
    //   width={300}
    //   opened={opened}
    //   onChange={setOpened}
    //   zIndex={constants.imageGeneration.drawerZIndex + 1}
    //   withinPortal
    // >
    //   <Popover.Target>
    //   </Popover.Target>

    //   <Popover.Dropdown p={0}>

    //   </Popover.Dropdown>
    // </Popover>
  );
}
