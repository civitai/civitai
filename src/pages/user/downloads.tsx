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
import { IconListCheck, IconSettings, IconTrash } from '@tabler/icons';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import { NotificationList } from '~/components/Notifications/NotificationList';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export default function Downloads() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { ref, inView } = useInView();

  const { data, isLoading, fetchNextPage, hasNextPage } =
    trpc.notification.getAllByUser.useInfiniteQuery(
      {},
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );
  const downloads = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data?.pages]);

  const readNotificationMutation = trpc.notification.markRead.useMutation({
    async onSuccess() {
      await queryUtils.user.checkNotifications.invalidate();
      await queryUtils.notification.getAllByUser.invalidate();
    },
  });
  const handleMarkAsRead = ({ id, all }: { id?: string; all?: boolean }) => {
    if (currentUser) readNotificationMutation.mutate({ id, all, userId: currentUser.id });
  };

  useEffect(() => {
    if (inView) {
      fetchNextPage();
    }
  }, [fetchNextPage, inView]);

  return (
    <Container size="xs">
      <Group position="apart">
        <Title order={1}>Downloads</Title>
        <Group spacing={8}>
          <Tooltip label="Clear history" position="bottom">
            <ActionIcon size="lg" onClick={() => handleRemoveDownload({ all: true })}>
              <IconTrash />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {isLoading ? (
        <Center>
          <Loader />
        </Center>
      ) : downloads.length > 0 ? (
        <Stack>
          <DownloadList
            items={downloads}
            onItemClick={(download) => handleRemoveDownload(download)}
            textSize="md"
            withDivider
          />
          {!isLoading && hasNextPage && (
            <Group position="center" ref={ref}>
              <Loader />
            </Group>
          )}
        </Stack>
      ) : (
        <Center>
          <Text>There are no downloads in your history</Text>
        </Center>
      )}
    </Container>
  );
}
