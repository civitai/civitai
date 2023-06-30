import { ModelType } from '@prisma/client';
import { useCallback, useState } from 'react';
import { useGenerationResourceStore } from './useGenerationResourceStore';
import { Card, Group, ActionIcon, Stack, Slider, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconX } from '@tabler/icons-react';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { useDebouncer } from '~/utils/debouncer';
import { Generation } from '~/server/services/generation/generation.types';

export function GenerationResources({ type }: { type: ModelType }) {
  const resources = useGenerationResourceStore(
    useCallback((state) => state.resources[type], [type])
  );

  return (
    <>
      {resources.map((resource) => (
        <GenerationResource key={resource.id} resource={resource} />
      ))}
    </>
  );
}

function GenerationResource({ resource }: { resource: Generation.Resource }) {
  const debouncer = useDebouncer(300);

  const update = useGenerationResourceStore((state) => state.updateResource);
  const remove = useGenerationResourceStore((state) => state.removeResource);

  const [strength, setStrength] = useState(resource.strength ?? 1);

  const hasTrainedWords = !!resource.trainedWords?.length;
  const hasStrength = resource.modelType === ModelType.LORA;
  const hasAdditionalContent = hasTrainedWords || hasStrength;
  const unavailable = resource?.covered === false;

  const handleStrengthChange = (strength: number) => {
    setStrength(strength);
    debouncer(() => update({ ...resource, strength }));
  };

  return (
    <Card p="xs" withBorder>
      <Card.Section withBorder={hasAdditionalContent} p="xs" py={6}>
        <Group spacing="xs" position="apart">
          {unavailable && (
            <ThemeIcon color="red" w="auto" size="sm" px={4}>
              <Group spacing={4}>
                <IconAlertTriangle size={16} strokeWidth={3} />
                <Text size="xs" weight={500}>
                  Unavailable
                </Text>
              </Group>
            </ThemeIcon>
          )}
          <Text lineClamp={1} size="sm" weight={500}>
            {resource.modelName} - {resource.name}
          </Text>
          <ActionIcon size="sm" variant="subtle" color="red" onClick={() => remove(resource.id)}>
            <IconX size={20} />
          </ActionIcon>
        </Group>
      </Card.Section>
      {hasAdditionalContent && !unavailable && (
        <Stack spacing={6} pt="xs">
          {/* LORA */}
          {hasStrength && (
            <Group spacing="xs" align="center">
              <Text size="xs" weight={500}>
                Strength
              </Text>
              <Slider
                precision={2}
                style={{ flex: 1 }}
                defaultValue={strength}
                onChange={handleStrengthChange}
                marks={[{ value: 0 }, { value: 1 }]}
                step={0.05}
                min={-1}
                max={2}
              />
              <Text size="xs" w={28} ta="right">{`${strength?.toFixed(2)}`}</Text>
            </Group>
          )}
          {hasTrainedWords && (
            <TrainedWords
              trainedWords={resource.trainedWords}
              type={resource.modelType}
              limit={4}
            />
          )}
        </Stack>
      )}
    </Card>
  );
}
