import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { Alert, Center, Loader, Stack, Text } from '@mantine/core';
import { IconCalendar, IconClock, IconInbox } from '@tabler/icons-react';

import { QueueItem } from '~/components/ImageGeneration/QueueItem';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { generationPanel } from '~/store/generation.store';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';

export function Queue() {
  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching, isError } =
    useGetTextToImageRequests();

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
      <Center h="100%">
        <Stack spacing="xs" align="center" py="16">
          <IconInbox size={64} stroke={1} />
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
        </Stack>
      </Center>
    );

  return (
    <ScrollArea scrollRestore={{ key: 'queue' }} className="flex flex-col gap-2 px-3">
      <Stack>
        <Text size="xs" color="dimmed" my={-10}>
          <IconCalendar size={14} style={{ display: 'inline', marginTop: -3 }} strokeWidth={2} />{' '}
          Generated images are only retained for 30 days.
        </Text>
        {data.map((request) => (
          <div key={request.id} id={request.id.toString()}>
            {createRenderElement(QueueItem, request.id, request)}
          </div>
        ))}
        {hasNextPage && (
          <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
            <Center sx={{ height: 60 }}>
              <Loader />
            </Center>
          </InViewLoader>
        )}
      </Stack>
    </ScrollArea>
  );
}

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap],
  (RenderComponent, index, request) => <RenderComponent index={index} request={request} />
);
