import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { Alert, Center, Loader, ScrollArea, Stack, Text } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';
import { useDeferredValue, useEffect } from 'react';
import { useInView } from 'react-intersection-observer';

import { generationPanel } from '~/components/ImageGeneration/GenerationPanel';
import { QueueItem } from '~/components/ImageGeneration/QueueItem';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Virtuoso } from 'react-virtuoso';
import { useGetGenerationRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';

export function Queue({
  requests,
  isLoading,
  fetchNextPage,
  hasNextPage,
  isRefetching,
  isFetching,
  isError,
}: ReturnType<typeof useGetGenerationRequests>) {
  const { ref, inView } = useInView();
  const mobile = useIsMobile({ breakpoint: 'md' });

  // infinite paging
  useEffect(() => {
    if (inView && !isFetching && !isError) fetchNextPage?.();
  }, [fetchNextPage, inView, isFetching, isError]);

  if (isError)
    return (
      <Alert color="red">
        <Text align="center">Could not retrieve image generation requests</Text>
      </Alert>
    );

  return isLoading ? (
    <Center p="xl">
      <Loader />
    </Center>
  ) : !!requests?.length ? (
    <>
      <Virtuoso
        style={{
          height: '100%',
        }}
        data={requests}
        components={{
          List: Stack,
        }}
        itemContent={(index, request) => createRenderElement(QueueItem, request.id, request)}
      />
      {/* <ScrollArea h="100%" sx={{ marginRight: -16, paddingRight: 16 }}>
        <Stack py="md">
          {requests.map((request, index) => (
            <div key={request.id}>{createRenderElement(QueueItem, request.id, request)}</div>
          ))}
          {hasNextPage && !isLoading && !isRefetching && (
            <Center p="xl" ref={ref} sx={{ height: 36 }} mt="md">
              {inView && <Loader />}
            </Center>
          )}
        </Stack>
      </ScrollArea> */}
    </>
  ) : (
    <Center h={mobile ? 'calc(90vh - 87px)' : 'calc(100vh - 87px)'}>
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
}

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap],
  (RenderComponent, index, request) => <RenderComponent index={index} request={request} />
);
