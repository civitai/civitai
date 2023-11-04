import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { Alert, Center, Loader, ScrollArea, Stack, Text } from '@mantine/core';
import { IconInbox } from '@tabler/icons-react';

import { QueueItem } from '~/components/ImageGeneration/QueueItem';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useGetGenerationRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { generationPanel } from '~/store/generation.store';
import { InViewLoader } from '~/components/InView/InViewLoader';

export function Queue({
  requests,
  isLoading,
  fetchNextPage,
  hasNextPage,
  isRefetching,
  isError,
}: ReturnType<typeof useGetGenerationRequests>) {
  const mobile = useIsMobile({ breakpoint: 'md' });

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
      {/* <Virtuoso
        style={{
          height: '100%',
        }}
        data={requests}
        components={{
          List: Stack,
        }}
        itemContent={(index, request) => createRenderElement(QueueItem, request.id, request)}
      /> */}
      <Stack p="md">
        {requests.map((request) => (
          <div key={request.id}>{createRenderElement(QueueItem, request.id, request)}</div>
        ))}
        {hasNextPage && (
          <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
            <Center p="xl" sx={{ height: 36 }} mt="md">
              <Loader />
            </Center>
          </InViewLoader>
        )}
      </Stack>
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
