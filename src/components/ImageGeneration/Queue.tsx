import OneKeyMap from '@essentials/one-key-map';
import trieMemoize from 'trie-memoize';
import { Alert, Button, Center, Loader, Stack, Text } from '@mantine/core';
import { IconCalendar, IconInbox } from '@tabler/icons-react';

import { QueueItem } from '~/components/ImageGeneration/QueueItem';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { generationPanel } from '~/store/generation.store';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { formatDate } from '~/utils/date-helpers';
import { useSchedulerDownloadingStore } from '~/store/scheduler-download.store';
import {
  downloadGeneratedImagesByDate,
  orchestratorIntegrationDate,
} from '~/server/common/constants';
import {
  InViewDiv,
  IntersectionObserverProvider,
} from '~/components/IntersectionObserver/IntersectionObserverProvider';

export function Queue() {
  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching, isError } =
    useGetTextToImageRequests();

  const { downloading } = useSchedulerDownloadingStore();
  const handleSetDownloading = () => useSchedulerDownloadingStore.setState({ downloading: true });
  const canDownload = new Date().getTime() < downloadGeneratedImagesByDate.getTime();

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

  const RetentionPolicyUpdate = canDownload ? (
    <div className="flex flex-col items-center justify-center gap-3 ">
      <div className="flex flex-col items-center justify-center">
        <Text color="dimmed">
          <IconCalendar size={14} style={{ display: 'inline', marginTop: -3 }} strokeWidth={2} />{' '}
          Images are kept in the generator for 30 days
        </Text>
        <Text color="dimmed">
          {
            'To download images created before this policy took effect, click the download button below'
          }
        </Text>
        {/* <Text color="dimmed" td="underline">
          Historical downloads have been temporarily disabled
        </Text> */}
      </div>
      <Button
        component="a"
        href="/api/generation/history"
        disabled={downloading}
        onClick={handleSetDownloading}
      >
        Download past images
      </Button>
    </div>
  ) : null;

  if (!data.length)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
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
        {RetentionPolicyUpdate}
      </div>
    );

  return (
    <ScrollArea scrollRestore={{ key: 'queue' }} className="px-3">
      <IntersectionObserverProvider
        id="generator-queue"
        className="flex flex-col gap-3"
        options={{ rootMargin: '200% 0px' }}
      >
        {canDownload && (
          <Text size="xs" color="dimmed" my={-10}>
            <IconCalendar size={14} style={{ display: 'inline', marginTop: -3 }} strokeWidth={2} />{' '}
            Images are kept in the generator for 30 days.{' '}
            {/* <Text span td="underline">
              {`You'll be able to download older images soon.`}
            </Text> */}
            <Text
              variant="link"
              td="underline"
              component="a"
              href="/api/generation/history"
              onClick={handleSetDownloading}
            >
              Download images created before {formatDate(orchestratorIntegrationDate)}
            </Text>
          </Text>
        )}
        {/* {data.map((request) =>
          request.steps.map((step) => createRenderElement(QueueItem, request, step))
        )} */}
        {data.map((request) =>
          request.steps.map((step) => (
            <InViewDiv key={request.id} id={request.id.toString()}>
              <QueueItem id={request.id.toString()} request={request} step={step} />
            </InViewDiv>
          ))
        )}
        {hasNextPage ? (
          <InViewLoader loadFn={fetchNextPage} loadCondition={!!data.length && !isRefetching}>
            <Center sx={{ height: 60 }}>
              <Loader />
            </Center>
          </InViewLoader>
        ) : (
          <div className="p-6">{RetentionPolicyUpdate}</div>
        )}
      </IntersectionObserverProvider>
    </ScrollArea>
  );
}

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, WeakMap, WeakMap],
  (RenderComponent, request, step) => (
    <RenderComponent key={request.id} id={request.id.toString()} request={request} step={step} />
  )
);
