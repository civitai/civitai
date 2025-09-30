import { Alert, Center, Loader, Stack, Text } from '@mantine/core';
import { IconCalendar, IconInbox } from '@tabler/icons-react';

import { QueueItem } from '~/components/ImageGeneration/QueueItem';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { generationPanel } from '~/store/generation.store';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useFiltersContext } from '~/providers/FiltersProvider';

export function Queue() {
  const filters = useFiltersContext((state) => state.generation);

  const {
    data = [],
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isRefetching,
    isError,
    error,
  } = useGetTextToImageRequests();

  if (isError)
    return (
      <Alert color="red">
        <Text align="center">Could not retrieve generation requests</Text>
        {error && (
          <Text align="center" size="xs">
            {error.data && `Status ${error.data?.httpStatus}:`} {error.message}
          </Text>
        )}
      </Alert>
    );

  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );

  if (!data.length)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Stack gap="xs" align="center" py="16">
          <IconInbox size={64} stroke={1} />
          {filters.marker && (
            <Stack gap={0}>
              <Text fz={32} align="center">
                No results found
              </Text>
              <Text align="center">{'Try adjusting your filters'}</Text>
            </Stack>
          )}
          {!filters.marker && (
            <Stack gap={0}>
              <Text size="md" align="center">
                The queue is empty
              </Text>
              <Text size="sm" c="dimmed">
                Try{' '}
                <Text
                  c="blue.4"
                  onClick={() => generationPanel.setView('generate')}
                  style={{ cursor: 'pointer' }}
                  span
                >
                  generating
                </Text>{' '}
                new images with our resources
              </Text>
            </Stack>
          )}
        </Stack>
      </div>
    );

  const { marker } = filters;

  return (
    <div className="flex flex-col gap-2 px-3">
      <Text size="xs" c="dimmed" mt="xs">
        <IconCalendar size={14} style={{ display: 'inline', marginTop: -3 }} strokeWidth={2} />{' '}
        Creations are kept in the Generator for 30 days. Download or Post them to your Profile to
        save them!
      </Text>
      <div className="flex flex-col gap-2">
        {data.map((request, index) => {
          return (
            <QueueItem
              key={request.id}
              id={request.id.toString()}
              request={request}
              step={request.steps[0]}
              filter={{ marker }}
            />
          );
        })}
      </div>
      {hasNextPage ? (
        <InViewLoader
          loadFn={fetchNextPage}
          loadCondition={!isFetching && !isRefetching && hasNextPage}
        >
          <Center style={{ height: 60 }}>
            <Loader />
          </Center>
        </InViewLoader>
      ) : null}
    </div>
  );
}

// supposedly ~5.5x faster than createElement without the memo
// const createRenderElement = trieMemoize(
//   [OneKeyMap, WeakMap, WeakMap],
//   (RenderComponent, request, step) => (
//     <RenderComponent key={request.id} id={request.id.toString()} request={request} step={step} />
//   )
// );
