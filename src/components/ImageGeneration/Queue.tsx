import { Alert, Center, Loader, ScrollArea, Stack, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconInbox } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useInView } from 'react-intersection-observer';

import { BoostModal } from '~/components/ImageGeneration/BoostModal';
import { generationPanel } from '~/components/ImageGeneration/GenerationPanel';
import { QueueItem } from '~/components/ImageGeneration/QueueItem';
import { useImageGenerationQueue } from '~/components/ImageGeneration/hooks/useImageGenerationState';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Generation } from '~/server/services/generation/generation.types';

type State = {
  selectedItem: Generation.Request | null;
  opened: boolean;
};

export function Queue() {
  const { ref, inView } = useInView();
  const mobile = useIsMobile({ breakpoint: 'md' });
  const [state, setState] = useState<State>({ selectedItem: null, opened: false });
  const [showBoostModal] = useLocalStorage({ key: 'show-boost-modal', defaultValue: true });

  const { requestIds, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching, isError } =
    useImageGenerationQueue();

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
  ) : requestIds.length > 0 ? (
    <>
      <ScrollArea h="100%" sx={{ marginRight: -16, paddingRight: 16 }}>
        <Stack py="md">
          {requestIds.map((id) => (
            <QueueItem
              key={id}
              id={id}
              onBoostClick={(item) =>
                showBoostModal ? setState({ selectedItem: item, opened: true }) : undefined
              }
            />
          ))}
          {hasNextPage && !isLoading && !isRefetching && (
            <Center p="xl" ref={ref} sx={{ height: 36 }} mt="md">
              {inView && <Loader />}
            </Center>
          )}
        </Stack>
      </ScrollArea>
      {showBoostModal && (
        <BoostModal
          opened={state.opened}
          onClose={() => setState({ selectedItem: null, opened: false })}
        />
      )}
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
