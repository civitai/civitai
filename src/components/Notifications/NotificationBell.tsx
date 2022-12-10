import {
  ActionIcon,
  Button,
  Center,
  Divider,
  Group,
  Indicator,
  Loader,
  Popover,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconBell, IconListCheck, IconSettings } from '@tabler/icons';
import { useState } from 'react';

import { NotificationList } from '~/components/Notifications/NotificationList';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function NotificationBell() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const [opened, setOpened] = useState(false);

  const { data: checkData, isLoading: loadingCheck } = trpc.user.checkNotifications.useQuery();
  const { data: notifications, isLoading: loadingNotifications } =
    trpc.notification.getAllByUser.useQuery({ limit: 10 }, { enabled: opened });

  const readNotificationMutation = trpc.notification.markRead.useMutation({
    async onSuccess() {
      await queryUtils.user.checkNotifications.invalidate();
      await queryUtils.notification.getAllByUser.invalidate();
    },
  });
  const handleMarkAsRead = ({ id, all }: { id?: string; all?: boolean }) => {
    if (currentUser) readNotificationMutation.mutate({ id, all, userId: currentUser.id });
  };

  return (
    <Popover position="bottom-end" width={300} opened={opened} onChange={setOpened}>
      <Popover.Target>
        <Indicator color="red" disabled={loadingCheck || !checkData?.count}>
          <ActionIcon
            variant={opened ? 'filled' : undefined}
            onClick={() => setOpened((val) => !val)}
          >
            <IconBell />
          </ActionIcon>
        </Indicator>
      </Popover.Target>

      <Popover.Dropdown p={0}>
        <Stack spacing={0}>
          <Group position="apart" p="sm">
            <Text weight="bold" size="sm">
              Notifications
            </Text>
            <Group spacing={8}>
              <Tooltip label="Mark all as read" position="bottom">
                <ActionIcon size="sm" onClick={() => handleMarkAsRead({ all: true })}>
                  <IconListCheck />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Notification settings" position="bottom">
                <ActionIcon
                  component={NextLink}
                  size="sm"
                  href="/user/account#notification-settings"
                >
                  <IconSettings />
                </ActionIcon>
              </Tooltip>
            </Group>
          </Group>
          <Divider />
          {loadingNotifications ? (
            <Center p="sm">
              <Loader />
            </Center>
          ) : notifications && notifications.items.length > 0 ? (
            <Stack spacing={0}>
              <ScrollArea.Autosize maxHeight={410}>
                <NotificationList
                  textSize="xs"
                  items={notifications.items}
                  onItemClick={(notification) => {
                    handleMarkAsRead({ id: notification.id });
                    setOpened(false);
                  }}
                />
              </ScrollArea.Autosize>
              <Divider />
              <Group p="sm" grow>
                <Button
                  component={NextLink}
                  variant="outline"
                  href="/user/notifications"
                  onClick={() => setOpened(false)}
                >
                  {checkData?.count ? `View All (${checkData.count} Unread)` : 'View All'}
                </Button>
              </Group>
            </Stack>
          ) : (
            <Center p="sm">
              <Text>All caught up! Nothing to see here</Text>
            </Center>
          )}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
