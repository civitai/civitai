import { Center, Container, Group, Loader, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import { useMemo } from 'react';
import { DownloadCard } from '~/components/Downloads/DownloadCard';
import {
  DownloadActiveFilters,
  DownloadFilterBar,
} from '~/components/Downloads/DownloadFiltersDropdown';
import {
  filterDownloads,
  getAvailableFilterOptions,
  useDownloadFilters,
} from '~/components/Downloads/download.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { DownloadHistoryItem } from '~/server/services/download.service';
import { trpc } from '~/utils/trpc';

export default function Downloads() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const { filters, setFilters, clearFilters, hasActiveFilters } = useDownloadFilters();

  const { data, isLoading } = trpc.download.getAllByUser.useQuery(undefined, {
    cacheTime: 0,
  });

  const downloads = data?.items ?? [];

  // Get available filter options from all downloads
  const availableOptions = useMemo(() => getAvailableFilterOptions(downloads), [downloads]);

  // Apply filters client-side
  const filteredDownloads = useMemo(
    () => filterDownloads(downloads, filters),
    [downloads, filters]
  );

  const hideDownloadMutation = trpc.download.hide.useMutation({
    async onMutate({ modelVersionId, all }) {
      // Optimistic update
      queryUtils.download.getAllByUser.setData(undefined, (oldData) => {
        if (!oldData || all) {
          return { items: [] };
        }

        return {
          ...oldData,
          items: oldData.items.filter((item) => item.modelVersion.id !== modelVersionId),
        };
      });
    },
  });

  const handleHide = (download: DownloadHistoryItem) => {
    if (currentUser) {
      hideDownloadMutation.mutate({
        modelVersionId: download.modelVersion.id,
      });
    }
  };

  const handleClearHistory = () => {
    if (currentUser) {
      hideDownloadMutation.mutate({ all: true });
    }
  };

  return (
    <Container size="md">
      {/* Title row with filter bar */}
      <Group justify="space-between" align="center" wrap="wrap" gap="md" mb="lg">
        <Title order={1}>Download History</Title>
        {downloads.length > 0 && (
          <DownloadFilterBar
            filters={filters}
            availableOptions={availableOptions}
            onFiltersChange={setFilters}
          />
        )}
      </Group>

      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : downloads.length > 0 ? (
        <Stack gap="lg">
          {/* Active filters row */}
          <DownloadActiveFilters
            filters={filters}
            onFiltersChange={setFilters}
            onClearFilters={clearFilters}
            onClearHistory={handleClearHistory}
            hasActiveFilters={hasActiveFilters}
          />

          {filteredDownloads.length > 0 ? (
            <Stack gap="sm">
              {filteredDownloads.map((download, index) => (
                <DownloadCard
                  key={`${download.modelVersion.id}-${download.file?.id ?? 0}-${index}`}
                  download={download}
                  onHide={handleHide}
                />
              ))}
            </Stack>
          ) : (
            <Stack align="center" py="xl">
              <ThemeIcon size={96} radius={100} variant="light" color="gray">
                <IconCloudOff size={60} />
              </ThemeIcon>
              <Text size="lg" ta="center">
                No downloads match your filters
              </Text>
              <Text size="sm" c="dimmed" ta="center">
                Try adjusting your filter criteria
              </Text>
            </Stack>
          )}
        </Stack>
      ) : (
        <Stack align="center" py="xl">
          <ThemeIcon size={96} radius={100} variant="light" color="gray">
            <IconCloudOff size={60} />
          </ThemeIcon>
          <Text size="lg" ta="center">
            No downloads in your history
          </Text>
        </Stack>
      )}
    </Container>
  );
}
