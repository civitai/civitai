import { Center, ScrollArea, SimpleGrid, Stack, Text } from '@mantine/core';
import { useDisclosure, useLocalStorage } from '@mantine/hooks';
import { IconInbox } from '@tabler/icons-react';
import { useState } from 'react';

import { BoostModal } from '~/components/ImageGeneration/BoostModal';
import { QueueItem } from '~/components/ImageGeneration/QueueItem';
import { useIsMobile } from '~/hooks/useIsMobile';

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
  selectedItem: QueueItem | null;
  opened: boolean;
};

export function Queue() {
  const mobile = useIsMobile({ breakpoint: 'md' });
  const [state, setState] = useState<State>({ selectedItem: null, opened: false });
  const [showBoostModal] = useLocalStorage({ key: 'show-boost-modal', defaultValue: true });

  return items.length > 0 ? (
    <>
      <ScrollArea.Autosize maxHeight={mobile ? 'calc(90vh - 87px)' : 'calc(100vh - 87px)'}>
        <SimpleGrid cols={1} spacing="md">
          {items.map((item) => (
            <QueueItem
              key={item.id}
              item={item}
              onBoostClick={(item) => showBoostModal ? setState({ selectedItem: item, opened: true }) : undefined}
            />
          ))}
        </SimpleGrid>
      </ScrollArea.Autosize>
      {showBoostModal && <BoostModal
        opened={state.opened}
        onClose={() => setState({ selectedItem: null, opened: false })}
      />}
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
