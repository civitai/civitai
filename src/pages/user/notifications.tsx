import {
  ActionIcon,
  Center,
  Container,
  Grid,
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

import { NotificationList } from '~/components/Notifications/NotificationList';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export default function Notifications() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching } =
    trpc.notification.getAllByUser.useInfiniteQuery(
      {},
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
    if (currentUser) readNotificationMutation.mutate({ id, all, userId: currentUser.id });
  };

  return (
    <>
      <Meta title="Notifications | Civitai" />
      <Container size="sm">
        <Grid gutter="xl" align="center">
          <Grid.Col span={12}>
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
          </Grid.Col>
          <Grid.Col span={12} px={0}>
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
          </Grid.Col>
        </Grid>
      </Container>
    </>
  );
}
