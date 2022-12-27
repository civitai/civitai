import {
  ActionIcon,
  Button,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconCloudOff, IconTrash } from '@tabler/icons';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';
import { DownloadList } from '~/components/Downloads/DownloadList';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export default function Downloads() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { ref, inView } = useInView();

  const { data, isLoading, fetchNextPage, hasNextPage } =
    trpc.download.getAllByUser.useInfiniteQuery(
      {},
      {
        getNextPageParam: (lastPage) => lastPage?.nextCursor,
        cacheTime: 0,
      }
    );
  const downloads = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data?.pages]);

  const hideDownloadMutation = trpc.download.hide.useMutation({
    async onMutate({ id, all }) {
      queryUtils.download.getAllByUser.setInfiniteData({}, (data) => {
        if (!data || all) {
          return {
            pages: [],
            pageParams: [],
          };
        }

        return {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.filter((item) => item.id !== id),
          })),
        };
      });
    },
  });
  const handleHide = ({ id, all }: { id?: number; all?: boolean }) => {
    if (currentUser) hideDownloadMutation.mutate({ id, all, userId: currentUser.id });
  };

  useEffect(() => {
    if (inView) {
      fetchNextPage();
    }
  }, [fetchNextPage, inView]);

  return (
    <Container size="xs">
      <Group position="apart" align="flex-end">
        <Title order={1}>Downloads</Title>
        <Group spacing={8}>
          <Button
            rightIcon={<IconTrash size={16} />}
            variant="subtle"
            size="xs"
            compact
            onClick={() => handleHide({ all: true })}
          >
            Clear History
          </Button>
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
            onHideClick={(download) => handleHide(download)}
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
        <Stack align="center" mt="md">
          <ThemeIcon size={96} radius={100}>
            <IconCloudOff size={60} />
          </ThemeIcon>
          <Text size={18} align="center">
            No downloads in your history
          </Text>
        </Stack>
      )}
    </Container>
  );
}
