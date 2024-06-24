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
import { useSessionStorage } from '@mantine/hooks';
import { useState } from 'react';

export function Queue() {
  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching, isError } =
    useGetTextToImageRequests();

  // const [downloading, setDownloading] = useSessionStorage({
  //   key: 'scheduler-downloading',
  //   defaultValue: false,
  // });
  const [downloading, setDownloading] = useState(false);

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

  const RetentionPolicyUpdate = (
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
      </div>
      <Button
        component="a"
        href="/api/generation/history"
        download
        disabled={downloading}
        onClick={() => setDownloading(true)}
      >
        Download past images
      </Button>
    </div>
  );

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
    <ScrollArea scrollRestore={{ key: 'queue' }} className="flex flex-col gap-2 px-3">
      <Stack>
        <Text size="xs" color="dimmed" my={-10}>
          <IconCalendar size={14} style={{ display: 'inline', marginTop: -3 }} strokeWidth={2} />{' '}
          Images are kept in the generator for 30 days{' '}
          {!downloading && (
            <Text
              variant="link"
              td="underline"
              component="a"
              href="/api/generation/history"
              download
              onClick={() => setDownloading(true)}
            >
              Download images created before {formatDate(new Date('6-24-2024'))}
            </Text>
          )}
        </Text>
        {data.map((request) =>
          request.steps.map((step) => (
            <div key={request.id} id={request.id.toString()}>
              {createRenderElement(QueueItem, request.id, request, step)}
            </div>
          ))
        )}
        {hasNextPage ? (
          <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching}>
            <Center sx={{ height: 60 }}>
              <Loader />
            </Center>
          </InViewLoader>
        ) : (
          <div className="p-6">{RetentionPolicyUpdate}</div>
        )}
      </Stack>
    </ScrollArea>
  );
}

// supposedly ~5.5x faster than createElement without the memo
const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap, WeakMap],
  (RenderComponent, index, request, step) => (
    <RenderComponent index={index} request={request} step={step} />
  )
);
