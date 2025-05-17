import {
  Button,
  Center,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Input,
} from '@mantine/core';
import { IconCloudOff, IconTrash, IconSearch } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { DownloadList } from '~/components/Downloads/DownloadList';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export default function Downloads() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const [filterText, setFilterText] = useState('');

  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching } =
    trpc.download.getAllByUser.useInfiniteQuery(
      {},
      {
        getNextPageParam: (lastPage) => lastPage?.nextCursor,
        cacheTime: 0,
      }
    );

  const downloads = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data?.pages]);

  const filteredDownloads = useMemo(() => {
    if (!filterText) return downloads;
    return downloads.filter((download) =>
      download.modelVersion?.model?.name?.toLowerCase().includes(filterText.toLowerCase())
    );
  }, [downloads, filterText]);

  const hideDownloadMutation = trpc.download.hide.useMutation({
    async onMutate({ modelVersionId, all }) {
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
            items: page.items.filter((item) => item.modelVersion.id !== modelVersionId),
          })),
        };
      });
    },
  });

  const handleHide = ({ modelVersion, all }: { modelVersion?: { id: number }; all?: boolean }) => {
    if (currentUser)
      hideDownloadMutation.mutate({
        modelVersionId: modelVersion?.id,
        all,
      });
  };

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

      {/* Search Filter Input */}
      <Input
        icon={<IconSearch size={16} />}
        placeholder="Filter by Model Name..."
        value={filterText}
        onChange={(event) => setFilterText(event.currentTarget.value)}
        mt="md"
      />

      {isLoading ? (
        <Center>
          <Loader />
        </Center>
      ) : downloads.length === 0 ? (
        // Case 1: No downloads at all
        <Stack align="center" mt="md">
          <ThemeIcon size={96} radius={100}>
            <IconCloudOff size={60} />
          </ThemeIcon>
          <Text size={18} align="center">
            No downloads in your history
          </Text>
        </Stack>
      ) : filteredDownloads.length === 0 ? (
        // Case 2: Downloads exist, but none match the filter
        <Stack align="center" mt="md">
          <ThemeIcon size={96} radius={100}>
            <IconSearch size={60} />
          </ThemeIcon>
          <Text size={18} align="center">
            No downloads match your current filter
          </Text>
        </Stack>
      ) : (
        // Case 3: Filtered downloads are displayed
        <Stack mt="lg">
          <DownloadList
            items={filteredDownloads}
            onHideClick={(download) => handleHide(download)}
            textSize="md"
            withDivider
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
      )}
    </Container>
  );
}
