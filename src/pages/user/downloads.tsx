import { Center, Container, Group, Loader, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { DownloadHistoryItem } from '~/server/services/download.service';
import { trpc } from '~/utils/trpc';

const ITEM_HEIGHT = 128; // Height of each DownloadCard (h-32 = 8rem = 128px)
const ITEM_GAP = 8; // Gap between items

export default function Downloads() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const scrollAreaRef = useScrollAreaRef();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

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

  // Calculate scroll margin (offset from top of scroll container to our list)
  useLayoutEffect(() => {
    if (listRef.current && scrollAreaRef?.current) {
      let offset = 0;
      let current: HTMLElement | null = listRef.current;
      while (current && current !== scrollAreaRef.current) {
        offset += current.offsetTop;
        current = current.offsetParent as HTMLElement;
      }
      setScrollMargin(offset);
    }
  }, [scrollAreaRef, isLoading]);

  // Set up virtualizer for efficient rendering using the main scroll area
  const virtualizer = useVirtualizer({
    count: filteredDownloads.length,
    getScrollElement: () => scrollAreaRef?.current ?? null,
    estimateSize: () => ITEM_HEIGHT + ITEM_GAP,
    overscan: 5,
    scrollMargin,
    getItemKey: (index) => {
      const download = filteredDownloads[index];
      return `${download.modelVersion.id}-${download.file?.id ?? 'no-file'}`;
    },
  });

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

  const handleHide = useCallback(
    (download: DownloadHistoryItem) => {
      if (currentUser) {
        hideDownloadMutation.mutate({
          modelVersionId: download.modelVersion.id,
        });
      }
    },
    [currentUser, hideDownloadMutation]
  );

  const handleClearHistory = useCallback(() => {
    if (currentUser) {
      hideDownloadMutation.mutate({ all: true });
    }
  }, [currentUser, hideDownloadMutation]);

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
            <div
              ref={listRef}
              style={{
                height: virtualizer.getTotalSize(),
                width: '100%',
                position: 'relative',
              }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const download = filteredDownloads[virtualItem.index];
                return (
                  <div
                    key={String(virtualItem.key)}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: ITEM_HEIGHT,
                      transform: `translateY(${virtualItem.start - scrollMargin}px)`,
                    }}
                  >
                    <DownloadCard download={download} onHide={handleHide} />
                  </div>
                );
              })}
            </div>
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
