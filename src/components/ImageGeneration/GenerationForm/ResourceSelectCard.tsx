import { ActionIcon, Card, Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconAlertTriangle, IconX } from '@tabler/icons-react';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { Generation } from '~/server/services/generation/generation.types';

export const ResourceSelectCard = ({
  resource,
  onUpdate,
  onRemove,
}: {
  resource: Generation.Resource;
  onUpdate?: (value: Generation.Resource) => void;
  onRemove?: (id: number) => void;
}) => {
  const hasTrainedWords = !!resource.trainedWords?.length;
  const hasStrength =
    resource.modelType === ModelType.LORA || resource.modelType === ModelType.LoCon;
  const hasAdditionalContent = hasTrainedWords || hasStrength;
  const unavailable = resource?.covered === false;

  return (
    <Card p="xs" withBorder>
      <Stack spacing={6}>
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
          {onRemove && (
            <ActionIcon size="sm" variant="subtle" onClick={() => onRemove(resource.id)}>
              <IconX size={20} />
            </ActionIcon>
          )}
        </Group>
        {hasAdditionalContent && !unavailable && (
          <>
            {/* LORA */}
            {hasStrength && onUpdate && (
              <Group spacing="xs" align="center">
                <Text size="xs" weight={500}>
                  Strength
                </Text>
                <NumberSlider
                  value={resource.strength}
                  onChange={(strength) => onUpdate({ ...resource, strength })}
                  min={-1}
                  max={2}
                  step={0.05}
                  sliderProps={{ marks: [{ value: 0 }, { value: 1 }] }}
                />
              </Group>
            )}
            {hasTrainedWords && (
              <TrainedWords
                trainedWords={resource.trainedWords}
                type={resource.modelType}
                limit={4}
              />
            )}
          </>
        )}
      </Stack>
    </Card>
  );
};
