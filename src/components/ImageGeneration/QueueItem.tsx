import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  HoverCard,
  Stack,
  Text,
  ThemeIcon,
  MantineColor,
  Tooltip,
  SimpleGrid,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconBolt, IconPhoto, IconX } from '@tabler/icons-react';

import { Collection } from '~/components/Collection/Collection';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { Countdown } from '~/components/Countdown/Countdown';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import {
  useImageGenerationRequest,
  useImageGenerationStore,
} from '~/components/ImageGeneration/hooks/useImageGenerationState';
import { Generation, GenerationRequestStatus } from '~/server/services/generation/generation.types';
import { formatDateMin } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';

const statusColors: Record<GenerationRequestStatus, MantineColor> = {
  [GenerationRequestStatus.Pending]: 'gray',
  [GenerationRequestStatus.Cancelled]: 'gray',
  [GenerationRequestStatus.Processing]: 'yellow',
  [GenerationRequestStatus.Succeeded]: 'green',
  [GenerationRequestStatus.Error]: 'red',
};

export function QueueItem({ id, onBoostClick }: Props) {
  const [showBoostModal] = useLocalStorage({ key: 'show-boost-modal', defaultValue: true });

  const item = useImageGenerationRequest(id);
  const removeRequest = useImageGenerationStore((state) => state.removeRequest);
  const deleteMutation = trpc.generation.deleteRequest.useMutation({
    onSuccess: (response, request) => {
      removeRequest(request.id);
    },
    onError: (err) => {
      console.log({ err });
    },
  });

  const { prompt, ...details } = item.params;

  const status = item.status ?? GenerationRequestStatus.Pending;
  const pendingProcessing =
    status === GenerationRequestStatus.Pending || status === GenerationRequestStatus.Processing;
  const succeeded = status === GenerationRequestStatus.Succeeded;
  const failed = status === GenerationRequestStatus.Error;

  return (
    <Card withBorder px="xs">
      <Card.Section py={4} inheritPadding withBorder>
        <Group position="apart">
          <Group spacing={8}>
            {!!item.images?.length && (
              <Tooltip label={status} withArrow color="dark">
                <ThemeIcon
                  variant={pendingProcessing ? 'filled' : 'light'}
                  w="auto"
                  h="auto"
                  size="sm"
                  color={statusColors[status]}
                  px={4}
                  py={2}
                  sx={{ cursor: 'default' }}
                >
                  <Group spacing={4}>
                    <IconPhoto size={16} />
                    <Text size="sm" inline weight={500}>
                      {item.images.length}
                    </Text>
                  </Group>
                </ThemeIcon>
              </Tooltip>
            )}
            {pendingProcessing && (
              <Button.Group>
                <Button
                  size="xs"
                  variant="outline"
                  color="gray"
                  sx={{ pointerEvents: 'none' }}
                  compact
                >
                  ETA <Countdown endTime={item.estimatedCompletionDate} />
                </Button>
                <HoverCard withArrow position="top" withinPortal>
                  <HoverCard.Target>
                    <Button
                      size="xs"
                      rightIcon={showBoostModal ? <IconBolt size={16} /> : undefined}
                      compact
                    >
                      Boost
                    </Button>
                  </HoverCard.Target>
                  <HoverCard.Dropdown title="Coming soon" maw={300}>
                    <Stack spacing={0}>
                      <Text weight={500}>Coming soon!</Text>
                      <Text size="xs">
                        Want to run this request faster? Boost it to the front of the queue.
                      </Text>
                    </Stack>
                  </HoverCard.Dropdown>
                </HoverCard>
              </Button.Group>
            )}
            <Text size="xs" color="dimmed">
              {formatDateMin(item.createdAt)}
            </Text>
          </Group>
          <ActionIcon
            color="red"
            size="md"
            onClick={() => deleteMutation.mutate({ id })}
            disabled={deleteMutation.isLoading}
          >
            <IconX size={20} />
          </ActionIcon>
        </Group>
      </Card.Section>
      <Stack py="xs" spacing={8}>
        <ContentClamp maxHeight={36} labelSize="xs">
          <Text lh={1.3}>{prompt}</Text>
        </ContentClamp>
        <Collection
          items={item.resources}
          limit={3}
          renderItem={(resource: any) => (
            <Badge size="sm">
              {resource.modelName} - {resource.name}
            </Badge>
          )}
          grouped
        />
        {!failed && !!item.images?.length && (
          <SimpleGrid
            spacing="xs"
            breakpoints={[
              { maxWidth: 'sm', cols: 2 },
              { minWidth: 'sm', cols: 4 },
            ]}
          >
            {item.images.map((image) => (
              <GeneratedImage
                key={image.id}
                height={item.params.height}
                width={item.params.width}
                image={image}
              />
            ))}
          </SimpleGrid>
        )}
      </Stack>
      <Card.Section
        withBorder
        sx={(theme) => ({
          marginLeft: -theme.spacing.xs,
          marginRight: -theme.spacing.xs,
        })}
      >
        <GenerationDetails
          label="Additional Details"
          params={details}
          labelWidth={150}
          paperProps={{ radius: 0, sx: { borderWidth: '1px 0 0 0' } }}
        />
      </Card.Section>
      {/* <Card.Section py="xs" inheritPadding>
        <Group position="apart" spacing={8}>
          <Text color="dimmed" size="xs">
            Fulfillment by {item.provider.name}
          </Text>
          <Text color="dimmed" size="xs">
            Started <DaysFromNow date={item.createdAt} />
          </Text>
        </Group>
      </Card.Section> */}
    </Card>
  );
}

type Props = {
  // item: Generation.Request;
  id: number;
  onBoostClick: (item: Generation.Request) => void;
};
