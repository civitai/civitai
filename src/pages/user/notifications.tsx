import {
  ActionIcon,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconListCheck, IconSettings } from '@tabler/icons-react';
import { useMemo } from 'react';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { Meta } from '~/components/Meta/Meta';

import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';
import { NotificationList } from '~/components/Notifications/NotificationList';
import { trpc } from '~/utils/trpc';

export default function Notifications() {
  const queryUtils = trpc.useContext();

  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching } =
    trpc.notification.getAllByUser.useInfiniteQuery(
      { limit: 100 },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
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
      <Meta title="Notifications | Civitai" />
      <Container size="sm">
        <ContainerGrid gutter="xl" align="center">
          <ContainerGrid.Col span={12}>
            <Group position="apart">
              <Title order={1}>Notifications</Title>
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
              </Group>
            </Group>
          </ContainerGrid.Col>
          <ContainerGrid.Col span={12} px={0}>
            {isLoading ? (
              <Center>
                <Loader />
              </Center>
            ) : notifications.length > 0 ? (
              <Stack>
                <NotificationList
                  items={notifications}
                  onItemClick={(notification) => handleMarkAsRead(notification)}
                  textSize="md"
                  withDivider
                  truncate={false}
                />
                {hasNextPage && (
                  <InViewLoader
                    loadFn={fetchNextPage}
                    loadCondition={!isRefetching}
                    style={{ gridColumn: '1/-1' }}
                  >
                    <Center p="xl" sx={{ height: 36 }} mt="md">
                      <Loader />
                    </Center>
                  </InViewLoader>
                )}
              </Stack>
            ) : (
              <Center>
                <Text>All caught up! Nothing to see here</Text>
              </Center>
            )}
          </ContainerGrid.Col>
        </ContainerGrid>
      </Container>
    </>
  );
}
