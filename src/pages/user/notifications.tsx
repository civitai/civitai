import {
  ActionIcon,
  Center,
  Container,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { NotificationCategory } from '@prisma/client';
import { IconListCheck, IconSettings } from '@tabler/icons-react';
import { useState } from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { Meta } from '~/components/Meta/Meta';

import { NotificationList } from '~/components/Notifications/NotificationList';
import {
  getCategoryDisplayName,
  useMarkReadNotification,
  useQueryNotifications,
} from '~/components/Notifications/notifications.utils';
import { NotificationTabs } from '~/components/Notifications/NotificationTabs';

export default function Notifications() {
  const [selectedCategory, setSelectedCategory] = useState<NotificationCategory | null>(null);

  const {
    notifications,
    isLoading: loadingNotifications,
    hasNextPage,
    fetchNextPage,
    isRefetching,
  } = useQueryNotifications({ limit: 20, category: selectedCategory });

  const readNotificationMutation = useMarkReadNotification();
  const categoryName = !selectedCategory ? 'all' : getCategoryDisplayName(selectedCategory);

  return (
    <>
      <Meta title="Notifications | Civitai" />
      <Container size="sm">
        <Stack spacing="xl">
          <Group position="apart">
            <Title order={1}>Notifications</Title>
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
                onItemClick={(notification) => {
                  readNotificationMutation.mutate({
                    id: notification.id,
                    category: notification.category,
                  });
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
      </Container>
    </>
  );
}
