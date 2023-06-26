import { Center, Loader, ScrollArea, SimpleGrid, Stack, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconInbox } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';

import { BoostModal } from '~/components/ImageGeneration/BoostModal';
import { QueueItem } from '~/components/ImageGeneration/QueueItem';
import { QueueItem2 } from '~/components/ImageGeneration/QueueItem2';
import { useGetGenerationRequests } from '~/components/ImageGeneration/hooks/useGetGenerationRequests';
import { useImageGenerationStore } from '~/components/ImageGeneration/hooks/useImageGenerationState';
import { useIsMobile } from '~/hooks/useIsMobile';
import { Generation, GenerationRequestStatus } from '~/server/services/generation/generation.types';
import { useDebouncer } from '~/utils/debouncer';

const items = [
  {
    id: 1,
    resources: [
      {
        id: 1,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 2,
        type: 'lora',
        name: 'cat lora',
      },
      {
        id: 3,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 4,
        type: 'lora',
        name: 'cat lora',
      },
    ],
    provider: {
      id: 1,
      name: 'OctoML',
    },
    createdAt: new Date('2021-08-01T00:00:00Z'),
    estimatedCompletionDate: new Date('2023-06-01T21:20:00Z'),
    images: [
      {
        url: 'https://images.unsplash.com/photo-1627971022501-6f4f5f1d3d5f?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=MnwyMjI0MjB8MHwxfHNlYXJjaHwxfHxjYXR8ZW58MHx8fHwxNjI4NjQ0MzYy&ixlib=rb-1.2.1&q=80&w=1080',
        available: false,
      },
      {
        url: 'https://images.unsplash.com/photo-1627971022501-6f4f5f1d3d5f?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=MnwyMjI0MjB8MHwxfHNlYXJjaHwxfHxjYXR8ZW58MHx8fHwxNjI4NjQ0MzYy&ixlib=rb-1.2.1&q=80&w=1080',
        available: false,
      },
      {
        url: 'https://images.unsplash.com/photo-1627971022501-6f4f5f1d3d5f?crop=entropy&cs=tinysrgb&fit=max&fm=jpg&ixid=MnwyMjI0MjB8MHwxfHNlYXJjaHwxfHxjYXR8ZW58MHx8fHwxNjI4NjQ0MzYy&ixlib=rb-1.2.1&q=80&w=1080',
        available: false,
      },
    ],
    params: {
      prompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      negativePrompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      aspectRatio: 'Square',
      scale: 'Creative',
      sampler: 'Fast',
      steps: 'Fast',
    },
  },
  {
    id: 2,
    resources: [
      {
        id: 1,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 2,
        type: 'lora',
        name: 'cat lora',
      },
      {
        id: 3,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 4,
        type: 'lora',
        name: 'cat lora',
      },
    ],
    provider: {
      id: 1,
      name: 'OctoML',
    },
    createdAt: new Date('2021-08-01T00:00:00Z'),

    estimatedCompletionDate: new Date('2023-06-01T21:20:00Z'),
    images: [{ url: '', available: false }],
    params: {
      prompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      negativePrompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      aspectRatio: 'Square',
      scale: 'Creative',
      sampler: 'Fast',
      steps: 'Fast',
    },
  },
  {
    id: 3,
    resources: [
      {
        id: 1,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 2,
        type: 'lora',
        name: 'cat lora',
      },
      {
        id: 3,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 4,
        type: 'lora',
        name: 'cat lora',
      },
    ],
    provider: {
      id: 1,
      name: 'OctoML',
    },
    createdAt: new Date('2021-08-01T00:00:00Z'),

    estimatedCompletionDate: new Date('2023-06-01T21:20:00Z'),
    images: [{ url: '', available: false }],
    params: {
      prompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      negativePrompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      aspectRatio: 'Square',
      scale: 'Creative',
      sampler: 'Fast',
      steps: 'Fast',
    },
  },
  {
    id: 4,
    resources: [
      {
        id: 1,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 2,
        type: 'lora',
        name: 'cat lora',
      },
      {
        id: 3,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 4,
        type: 'lora',
        name: 'cat lora',
      },
    ],
    provider: {
      id: 1,
      name: 'OctoML',
    },
    createdAt: new Date('2021-08-01T00:00:00Z'),

    estimatedCompletionDate: new Date('2023-06-01T21:20:00Z'),
    images: [{ url: '', available: false }],
    params: {
      prompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      negativePrompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      aspectRatio: 'Square',
      scale: 'Creative',
      sampler: 'Fast',
      steps: 'Fast',
    },
  },
  {
    id: 5,
    resources: [
      {
        id: 1,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 2,
        type: 'lora',
        name: 'cat lora',
      },
      {
        id: 3,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 4,
        type: 'lora',
        name: 'cat lora',
      },
    ],
    provider: {
      id: 1,
      name: 'OctoML',
    },
    createdAt: new Date('2021-08-01T00:00:00Z'),

    estimatedCompletionDate: new Date('2023-06-01T21:20:00Z'),
    images: [{ url: '', available: false }],
    params: {
      prompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      negativePrompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      aspectRatio: 'Square',
      scale: 'Creative',
      sampler: 'Fast',
      steps: 'Fast',
    },
  },
  {
    id: 6,
    resources: [
      {
        id: 1,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 2,
        type: 'lora',
        name: 'cat lora',
      },
      {
        id: 3,
        type: 'checkpoint',
        name: 'cat',
      },
      {
        id: 4,
        type: 'lora',
        name: 'cat lora',
      },
    ],
    provider: {
      id: 1,
      name: 'OctoML',
    },
    createdAt: new Date('2021-08-01T00:00:00Z'),

    estimatedCompletionDate: new Date('2023-06-01T21:20:00Z'),
    images: [{ url: '', available: false }],
    params: {
      prompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      negativePrompt:
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nullam consectetur felis magna, at ullamcorper metus euismod at. Donec quis sapien tristique massa viverra volutpat sed ut metus. Fusce leo quam, mollis sit amet commodo cursus, congue a metus. Donec nec placerat sapien. Suspendisse volutpat elit sem, quis hendrerit diam cursus ut. Etiam tincidunt interdum nisl a pretium. Duis ultricies accumsan elit, a venenatis eros commodo in. Nam a elit at nisl interdum hendrerit eget ac lacus. Nunc pharetra id dolor et suscipit. Proin eu vulputate nisl, vehicula rhoncus tellus. Vivamus egestas eu mauris a maximus. Duis a elementum ante, eget imperdiet mauris. Morbi congue, ligula in efficitur suscipit, felis diam tincidunt elit, vitae feugiat mauris nisi fermentum nisl.',
      aspectRatio: 'Square',
      scale: 'Creative',
      sampler: 'Fast',
      steps: 'Fast',
    },
  },
];

type QueueItem = (typeof items)[0];

type State = {
  selectedItem: Generation.Client.Request | null;
  opened: boolean;
};

const POLLABLE_STATUSES = [GenerationRequestStatus.Pending, GenerationRequestStatus.Processing];
export function Queue() {
  const { ref, inView } = useInView();
  const mobile = useIsMobile({ breakpoint: 'md' });
  const [state, setState] = useState<State>({ selectedItem: null, opened: false });
  const [showBoostModal] = useLocalStorage({ key: 'show-boost-modal', defaultValue: true });
  const debouncer = useDebouncer(5000);

  // Global store values
  const requests = useImageGenerationStore((state) => state.requests);
  const setRequests = useImageGenerationStore((state) => state.setRequests);
  const requestIds = Object.values(requests)
    .sort((a, b) => b.id - a.id)
    .map((x) => x.id);

  const {
    requests: infiniteRequests,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isRefetching,
    isFetching,
    isError,
  } = useGetGenerationRequests({ take: 10 });

  const { requests: polledRequests, refetch: pollPending } = useGetGenerationRequests(
    {
      take: 100,
      requestId: Object.values(requests)
        .filter((x) => POLLABLE_STATUSES.includes(x.status))
        .map((x) => x.id),
    },
    { enabled: false }
  );

  // infinite paging
  useEffect(() => {
    if (inView && !isFetching && !isError) fetchNextPage?.();
  }, [fetchNextPage, inView, isFetching, isError]);

  // set requests from infinite paging data
  useEffect(() => setRequests(infiniteRequests), [infiniteRequests, setRequests]);

  // debounced polling of pending/processing requests
  useEffect(() => {
    if (Object.values(requests).some((x) => POLLABLE_STATUSES.includes(x.status))) {
      debouncer(pollPending);
    }
  }, [requests, debouncer, pollPending]);

  // update requests dictionary with polled requests
  useEffect(() => setRequests(polledRequests), [polledRequests, setRequests]);

  return isLoading ? (
    <Center p="xl">
      <Loader />
    </Center>
  ) : requestIds.length > 0 ? (
    <>
      <ScrollArea.Autosize maxHeight={mobile ? 'calc(90vh - 87px)' : 'calc(100vh - 87px)'}>
        <Stack>
          {requestIds.map((id) => (
            <QueueItem2
              key={id}
              id={id}
              // onBoostClick={(item) =>
              //   showBoostModal ? setState({ selectedItem: item, opened: true }) : undefined
              // }
            />
          ))}
          {hasNextPage && !isLoading && !isRefetching && (
            <Center p="xl" ref={ref} sx={{ height: 36 }} mt="md">
              {inView && <Loader />}
            </Center>
          )}
        </Stack>
      </ScrollArea.Autosize>
      {showBoostModal && (
        <BoostModal
          opened={state.opened}
          onClose={() => setState({ selectedItem: null, opened: false })}
        />
      )}
    </>
  ) : (
    <Center h={mobile ? 'calc(90vh - 87px)' : 'calc(100vh - 87px)'}>
      <Stack spacing="xs" align="center">
        <IconInbox size={64} stroke={1} />
        <Stack spacing={0}>
          <Text size="md" align="center">
            The queue is empty
          </Text>
          <Text size="sm" color="dimmed">
            Try{' '}
            <Text variant="link" span>
              generating
            </Text>{' '}
            new images with our resources
          </Text>
        </Stack>
      </Stack>
    </Center>
  );
}
