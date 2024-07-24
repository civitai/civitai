import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Overlay,
  useMantineTheme,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { ModelType } from '@prisma/client';
import { IconAlertTriangle, IconReplace, IconX } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { GenerationResourceSchema } from '~/server/schema/generation.schema';
import { generationPanel } from '~/store/generation.store';

type Props = {
  resource: GenerationResourceSchema;
  isTraining?: boolean;
  onUpdate?: (value: GenerationResourceSchema) => void;
  onRemove?: (id: number) => void;
  onSwap?: VoidFunction;
  disabled?: boolean;
};

export const ResourceSelectCard = (props: Props) => {
  const isCheckpoint = props.resource.modelType === ModelType.Checkpoint;
  const theme = useMantineTheme();

  return (
    <div className="relative">
      {props.disabled && (
        <Overlay
          blur={3}
          zIndex={10}
          color={theme.colorScheme === 'dark' ? theme.colors.dark[7] : '#fff'}
          opacity={0.8}
        />
      )}
      {isCheckpoint ? <CheckpointInfo {...props} /> : <ResourceInfo {...props} />}
    </div>
  );
};

function CheckpointInfo({ resource, isTraining, onRemove, onSwap }: Props) {
  const unavailable = isTraining ? false : resource.covered === false;

  return (
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
        ) : resource.image ? (
          <Paper radius="sm" mr={8} style={{ overflow: 'hidden' }} w={64} h={64}>
            <EdgeMedia type="image" src={resource.image?.url} width={64} />
          </Paper>
        ) : null}
        <Stack spacing={2}>
          <Text
            component={NextLink}
            sx={(theme) => ({
              cursor: 'pointer',
              color: theme.colorScheme === 'dark' ? theme.white : theme.black,
            })}
            href={`/models/${resource.modelId}?modelVersionId=${resource.id}`}
            rel="nofollow noindex"
            color="initial"
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
      {onRemove ? (
        <ActionIcon size="sm" variant="subtle" onClick={() => onRemove(resource.id)}>
          <IconX size={20} />
        </ActionIcon>
      ) : (
        <Button variant="light" radius="xl" size="sm" onClick={onSwap} compact>
          <Group spacing={4} noWrap>
            <IconReplace size={16} />
            <Text size="sm" weight={500}>
              Swap
            </Text>
          </Group>
        </Button>
      )}
    </Group>
  );
}

function ResourceInfo({ resource, onRemove, onUpdate }: Props) {
  const hasStrength = ['LORA', 'LoCon', 'DoRA'].includes(resource.modelType);
  const isSameMinMaxStrength = resource.minStrength === resource.maxStrength;
  const unavailable = resource.covered === false;

  return (
    <Group spacing="xs" position="apart" noWrap>
      <Stack spacing={4} w="100%">
        <Group spacing={4} position="apart" noWrap>
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
          </Group>
          {resource.modelName.toLowerCase() !== resource.name.toLowerCase() && (
            <Badge size="sm" color="dark.5" variant="filled" miw="42px">
              {resource.name}
            </Badge>
          )}
        </Group>
        {/* LORA */}
        {hasStrength && onUpdate && !unavailable && (
          <Group spacing="xs" align="center">
            <NumberSlider
              value={resource.strength}
              onChange={(strength) => onUpdate({ ...resource, strength })}
              min={!isSameMinMaxStrength ? resource.minStrength ?? -1 : -1}
              max={!isSameMinMaxStrength ? resource.maxStrength ?? 2 : 2}
              step={0.05}
              sx={{ flex: 1 }}
              reverse
            />
          </Group>
        )}
      </Stack>
      {onRemove && (
        <ActionIcon size="sm" variant="subtle" onClick={() => onRemove(resource.id)}>
          <IconX size={20} />
        </ActionIcon>
      )}
    </Group>
  );
}
