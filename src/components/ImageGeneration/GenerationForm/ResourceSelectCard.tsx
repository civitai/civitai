import { ActionIcon, Badge, Card, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { ModelType } from '@prisma/client';
import { IconAlertTriangle, IconX } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { Generation } from '~/server/services/generation/generation.types';
import { generationPanel } from '~/store/generation.store';

type Props = {
  resource: Generation.Resource;
  onUpdate?: (value: Generation.Resource) => void;
  onRemove?: (id: number) => void;
};

export const ResourceSelectCard = (props: Props) => {
  const isCheckpoint = props.resource.modelType === ModelType.Checkpoint;

  return isCheckpoint ? <CheckpointInfo {...props} /> : <ResourceInfo {...props} />;
};

function CheckpointInfo({ resource, onRemove }: Props) {
  const unavailable = resource.covered === false;

  return (
    <Card px="sm" py={8} radius="md" withBorder>
      <Group spacing="xs" position="apart" noWrap>
        <Group spacing={4} noWrap>
          {unavailable ? (
            <ThemeIcon color="red" w="auto" size="sm" px={4} mr={8}>
              <Group spacing={4}>
                <IconAlertTriangle size={16} strokeWidth={3} />
                <Text size="xs" weight={500}>
                  Unavailable
                </Text>
              </Group>
            </ThemeIcon>
          ) : (
            <Paper radius="sm" mr={8} style={{ overflow: 'hidden' }} w={64} h={64}>
              <EdgeMedia type="image" src={resource.image?.url} width={64} />
            </Paper>
          )}
          <Stack spacing={2}>
            <Text
              component={NextLink}
              sx={{ cursor: 'pointer' }}
              href={`/models/${resource.modelId}?modelVersionId=${resource.id}`}
              onClick={() => generationPanel.close()}
              rel="nofollow noindex"
              lineClamp={1}
              weight={590}
            >
              {resource.modelName}
            </Text>
            <Text size="sm" color="dimmed">
              {resource.name}
            </Text>
          </Stack>
        </Group>
        {onRemove && (
          <ActionIcon size="sm" variant="subtle" onClick={() => onRemove(resource.id)}>
            <IconX size={20} />
          </ActionIcon>
        )}
      </Group>
    </Card>
  );
}

function ResourceInfo({ resource, onRemove, onUpdate }: Props) {
  const hasStrength =
    resource.modelType === ModelType.LORA || resource.modelType === ModelType.LoCon;
  const unavailable = resource.covered === false;

  return (
    <Stack spacing={6}>
      <Group spacing="xs" position="apart" noWrap>
        <Group spacing={4} noWrap>
          {unavailable && (
            <ThemeIcon color="red" w="auto" size="sm" px={4} mr={8}>
              <Group spacing={4}>
                <IconAlertTriangle size={16} strokeWidth={3} />
                <Text size="xs" weight={500}>
                  Unavailable
                </Text>
              </Group>
            </ThemeIcon>
          )}
          <Text
            component={NextLink}
            sx={{ cursor: 'pointer' }}
            href={`/models/${resource.modelId}?modelVersionId=${resource.id}`}
            onClick={() => generationPanel.close()}
            rel="nofollow noindex"
            size="sm"
            lineClamp={1}
            weight={590}
          >
            {resource.modelName}
          </Text>
          <Badge size="sm" color="dark.5" variant="filled">
            {resource.name}
          </Badge>
        </Group>
        {onRemove && (
          <ActionIcon size="sm" variant="subtle" onClick={() => onRemove(resource.id)}>
            <IconX size={20} />
          </ActionIcon>
        )}
      </Group>
      {/* LORA */}
      {hasStrength && onUpdate && !unavailable && (
        <Group spacing="xs" align="center">
          <NumberSlider
            value={resource.strength}
            onChange={(strength) => onUpdate({ ...resource, strength })}
            min={resource.minStrength ?? -1}
            max={resource.maxStrength ?? 2}
            step={0.05}
            sx={{ flex: 1 }}
            reverse
          />
        </Group>
      )}
    </Stack>
  );
}
