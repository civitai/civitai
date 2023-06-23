import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconBolt, IconPhoto, IconX } from '@tabler/icons-react';
import { useCallback } from 'react';

import { Collection } from '~/components/Collection/Collection';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { Countdown } from '~/components/Countdown/Countdown';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { useImageGenerationStore } from '~/components/ImageGeneration/hooks/useImageGenerationState';
import { Generation } from '~/server/services/generation/generation.types';
import { splitUppercase, titleCase } from '~/utils/string-helpers';

export function QueueItem({ id, onBoostClick }: Props) {
  const [showBoostModal] = useLocalStorage({ key: 'show-boost-modal', defaultValue: true });

  const item = useImageGenerationStore(useCallback((state) => state.requests[id], []));

  const { prompt, ...details } = item.params;
  const detailItems = Object.entries(details).map(([key, value]) => ({
    label: titleCase(splitUppercase(key)),
    value: <ContentClamp maxHeight={44}>{value as string}</ContentClamp>,
  }));

  return (
    <Card withBorder>
      <Card.Section py="xs" inheritPadding withBorder>
        <Group position="apart">
          <Group spacing={8}>
            {!!item.images?.length && (
              <ThemeIcon variant="outline" w="auto" h="auto" size="sm" color="gray" px={8} py={2}>
                <Group spacing={8}>
                  <IconPhoto size={16} />
                  <Text size="sm" inline>
                    {item.images.length}
                  </Text>
                </Group>
              </ThemeIcon>
            )}
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
              <Button
                size="xs"
                // TODO.generations: add action when modal is deactivated
                rightIcon={showBoostModal ? <IconBolt size={16} /> : undefined}
                onClick={() => onBoostClick(item)}
                compact
              >
                Boost
                {/* TODO.generations - probably need to confirm boost since buzz = money */}
              </Button>
              {!showBoostModal && (
                <Button
                  size="xs"
                  variant="white"
                  color="gray"
                  px={4}
                  sx={{ pointerEvents: 'none' }}
                  compact
                >
                  <Group spacing={2}>
                    <IconBolt size={16} />
                    <Text size="xs" inline>
                      10
                    </Text>
                  </Group>
                </Button>
              )}
            </Button.Group>
          </Group>
          <ActionIcon color="red" size="md">
            <IconX />
          </ActionIcon>
        </Group>
      </Card.Section>
      <Stack py="md" spacing={8}>
        <ContentClamp maxHeight={44}>
          <Text>{prompt}</Text>
        </ContentClamp>
        <Collection
          items={item.resources}
          limit={3}
          renderItem={(resource: any) => <Badge size="sm">{resource.name}</Badge>}
          grouped
        />
      </Stack>
      <Card.Section withBorder>
        <Accordion variant="filled">
          <Accordion.Item value="details">
            <Accordion.Control>Additional Details</Accordion.Control>
            <Accordion.Panel>
              <DescriptionTable items={detailItems} labelWidth={150} />
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
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
  // item: Generation.Client.Request;
  id: number;
  onBoostClick: (item: Generation.Client.Request) => void;
};
