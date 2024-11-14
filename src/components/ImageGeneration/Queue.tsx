import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { Alert, Center, Loader, Stack, Text } from '@mantine/core';
import { IconCalendar, IconInbox } from '@tabler/icons-react';

import { QueueItem } from '~/components/ImageGeneration/QueueItem';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { generationPanel } from '~/store/generation.store';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { MarkerType } from '~/server/common/enums';

export function Queue() {
  const { filters } = useFiltersContext((state) => ({
    filters: state.markers,
    setFilters: state.setMarkerFilters,
  }));

  let workflowTagsFilter = undefined;

  switch (filters.marker) {
    case MarkerType.Favorited:
      workflowTagsFilter = [WORKFLOW_TAGS.FAVORITE];
      break;

    case MarkerType.Liked:
      workflowTagsFilter = [WORKFLOW_TAGS.FEEDBACK.LIKED];
      break;

    case MarkerType.Disliked:
      workflowTagsFilter = [WORKFLOW_TAGS.FEEDBACK.DISLIKED];
      break;
  }

  const { data, isLoading, fetchNextPage, hasNextPage, isFetching, isRefetching, isError } =
    useGetTextToImageRequests({
      tags: workflowTagsFilter,
    });

  if (isError)
    return (
      <Alert color="red">
        <Text align="center">Could not retrieve image generation requests</Text>
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
        <Stack spacing="xs" align="center" py="16">
          <IconInbox size={64} stroke={1} />
          {filters.marker && (
            <Stack spacing={0}>
              <Text size={32} align="center">
                No results found
              </Text>
              <Text align="center">{'Try adjusting your filters'}</Text>
            </Stack>
          )}
          {!filters.marker && (
            <Stack spacing={0}>
              <Text size="md" align="center">
                The queue is empty
              </Text>
              <Text size="sm" color="dimmed">
                Try{' '}
                <Text
                  variant="link"
                  onClick={() => generationPanel.setView('generate')}
                  sx={{ cursor: 'pointer' }}
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

  return (
    <div className="flex flex-col gap-2 px-3">
      <Text size="xs" color="dimmed" mt="xs">
        <IconCalendar size={14} style={{ display: 'inline', marginTop: -3 }} strokeWidth={2} />{' '}
        Images are kept in the generator for 30 days.
      </Text>
      <div className="flex flex-col gap-2">
        {data.map((request) =>
          request.steps.map((step) => {
            const { marker } = filters;

            return (
              <QueueItem
                key={request.id}
                id={request.id.toString()}
                request={request}
                step={step}
                filter={{ marker }}
              />
            );
          })
        )}
      </div>
      {hasNextPage ? (
        <InViewLoader
          loadFn={fetchNextPage}
          loadCondition={!isFetching && !isRefetching && hasNextPage}
        >
          <Center sx={{ height: 60 }}>
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
