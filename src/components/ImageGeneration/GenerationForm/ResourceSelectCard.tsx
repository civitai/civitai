import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Overlay,
  Paper,
  Popover,
  Stack,
  Text,
  ThemeIcon,
  useMantineTheme,
  Anchor,
} from '@mantine/core';
import { IconAlertTriangle, IconBolt, IconReplace, IconWeight, IconX } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ResourceSelectSource } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { GenerationResourceSchema } from '~/server/schema/generation.schema';
import { ModelType } from '~/shared/utils/prisma/enums';
import { generationPanel } from '~/store/generation.store';

type Props = {
  resource: GenerationResourceSchema;
  selectSource?: ResourceSelectSource;
  onUpdate?: (value: GenerationResourceSchema) => void;
  onRemove?: (id: number) => void;
  onSwap?: VoidFunction;
  disabled?: boolean;
  hideVersion?: boolean;
};

export const ResourceSelectCard = (props: Props) => {
  const isCheckpoint = props.resource.model.type === ModelType.Checkpoint;
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

function CheckpointInfo({ resource, onRemove, onSwap, selectSource, hideVersion }: Props) {
  const unavailable = selectSource !== 'generation' ? false : resource.canGenerate !== true;

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
          <Paper
            radius="sm"
            mr={8}
            style={{ overflow: 'hidden', flexGrow: 0, flexShrink: 0 }}
            w={64}
            h={64}
          >
            <EdgeMedia
              type="image"
              src={resource.image?.url}
              width={64}
              className="h-full object-cover"
            />
          </Paper>
        ) : null}
        <Stack spacing={2}>
          <Text
            component={Link}
            sx={(theme) => ({
              cursor: 'pointer',
              color: theme.colorScheme === 'dark' ? theme.white : theme.black,
            })}
            href={`/models/${resource.model.id}?modelVersionId=${resource.id}`}
            rel="nofollow noindex"
            color="initial"
            lineClamp={1}
            weight={590}
          >
            {resource.model.name}
          </Text>
          {!hideVersion && (
            <Text size="sm" color="dimmed">
              {resource.name}
            </Text>
          )}
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

function ResourceInfo({ resource, onRemove, onUpdate, selectSource }: Props) {
  const hasStrength = ['LORA', 'LoCon', 'DoRA'].includes(resource.model.type);
  const isSameMinMaxStrength = resource.minStrength === resource.maxStrength;
  const unavailable = selectSource !== 'generation' ? false : !resource.canGenerate;
  const theme = useMantineTheme();

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
              component={Link}
              sx={{ cursor: 'pointer' }}
              href={`/models/${resource.model.id}?modelVersionId=${resource.id}`}
              onClick={() => generationPanel.close()}
              rel="nofollow noindex"
              size="sm"
              lineClamp={1}
              weight={590}
            >
              {resource.model.name}
            </Text>
          </Group>
          <div className="flex gap-1">
            {resource.model.name.toLowerCase() !== resource.name.toLowerCase() && (
              <Badge size="sm" color="dark.5" variant="filled" miw="42px">
                {resource.name}
              </Badge>
            )}

            {resource.additionalResourceCost && selectSource === 'generation' && (
              <Popover position="bottom" withArrow width={200}>
                <Popover.Target>
                  <ActionIcon size={18} color="blue" variant="filled">
                    <IconWeight size={14} />
                  </ActionIcon>
                </Popover.Target>
                <Popover.Dropdown>
                  <Text size="sm">
                    This resource carries an additional{' '}
                    <Anchor component={Link} href="/articles/7929">
                      buzz cost
                    </Anchor>
                  </Text>
                </Popover.Dropdown>
              </Popover>
            )}
            {resource.earlyAccessEndsAt && (
              <Popover position="bottom" withArrow width={200}>
                <Popover.Target>
                  <ActionIcon size={18} color="yellow.7" variant="filled">
                    <IconBolt style={{ fill: theme.colors.dark[9] }} color="dark.9" size={16} />
                  </ActionIcon>
                </Popover.Target>
                <Popover.Dropdown>
                  <Text size="sm">This resource is in early access</Text>
                </Popover.Dropdown>
              </Popover>
            )}
          </div>
        </Group>
        {/* LORA */}
        {hasStrength && onUpdate && !unavailable && (
          <div className="flex w-full items-center gap-2">
            <NumberSlider
              value={resource.strength}
              onChange={(strength) => onUpdate({ ...resource, strength: strength ?? 1 })}
              min={!isSameMinMaxStrength ? resource.minStrength : -1}
              max={!isSameMinMaxStrength ? resource.maxStrength : 2}
              step={0.05}
              sx={{ flex: 1 }}
              reverse
            />
          </div>
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
