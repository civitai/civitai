import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Group,
  GroupProps,
  Overlay,
  Paper,
  Popover,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconLock,
  IconReplace,
  IconWeight,
  IconX,
} from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ResourceSelectSource } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { ModelVersionPopularity } from '~/components/Model/ModelVersions/ModelVersionPopularity';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { GenerationResourceSchema } from '~/server/schema/generation.schema';
import { Availability, ModelType } from '~/shared/utils/prisma/enums';
import { generationPanel } from '~/store/generation.store';

type Props = {
  resource: GenerationResourceSchema;
  selectSource?: ResourceSelectSource;
  onUpdate?: (value: GenerationResourceSchema) => void;
  onRemove?: (id: number) => void;
  onSwap?: VoidFunction;
  disabled?: boolean;
  hideVersion?: boolean;
  groupPosition?: GroupProps['justify'];
  showAsCheckpoint?: boolean;
};

export const ResourceSelectCard = (props: Props) => {
  const isCheckpoint = props.resource.model.type === ModelType.Checkpoint;

  return (
    <div className="relative">
      {props.disabled && (
        <Overlay blur={3} zIndex={10} className="bg-white dark:bg-dark-7" opacity={0.8} />
      )}
      {isCheckpoint || props.showAsCheckpoint ? (
        <CheckpointInfo {...props} />
      ) : (
        <ResourceInfoCard {...props} />
      )}
    </div>
  );
};

function CheckpointInfo({
  resource,
  onRemove,
  onSwap,
  selectSource,
  hideVersion,
  groupPosition,
}: Props) {
  const unavailable = selectSource !== 'generation' ? false : resource.canGenerate !== true;

  return (
    <Group gap="xs" justify={groupPosition ?? 'space-between'} wrap="nowrap">
      <Group gap={4} wrap="nowrap">
        {unavailable ? (
          <ThemeIcon color="red" w="auto" size="sm" px={4} mr={8}>
            <Group gap={4}>
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
              type={resource.image.type ?? 'image'}
              src={resource.image.url}
              width={64}
              className="h-full object-cover"
            />
          </Paper>
        ) : null}
        <Stack gap={2}>
          <Text
            component={Link}
            className="cursor-pointer text-black dark:text-white"
            style={{ overflowWrap: 'anywhere' }}
            href={`/models/${resource.model.id}?modelVersionId=${resource.id}`}
            rel="nofollow noindex"
            c="initial"
            lineClamp={1}
            weight={590}
          >
            {resource.model.name}
          </Text>
          {!hideVersion && (
            <Text size="sm" c="dimmed">
              {resource.name}
            </Text>
          )}
          {selectSource === 'generation' && (
            <ModelVersionPopularity
              versionId={resource.id}
              isCheckpoint={resource.model.type === ModelType.Checkpoint}
              listenForUpdates={true}
            />
          )}
        </Stack>
      </Group>
      {onRemove ? (
        <ActionIcon size="sm" variant="subtle" onClick={() => onRemove(resource.id)}>
          <IconX size={20} />
        </ActionIcon>
      ) : (
        <Button variant="light" radius="xl" onClick={onSwap} size="compact-sm">
          <Group gap={4} wrap="nowrap">
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

function ResourceInfoCard({ resource, onRemove, onUpdate, selectSource }: Props) {
  const hasStrength = ['LORA', 'LoCon', 'DoRA'].includes(resource.model.type);
  const isSameMinMaxStrength = resource.minStrength === resource.maxStrength;
  const unavailable = selectSource !== 'generation' ? false : !resource.canGenerate;

  return (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <Stack gap={4} w="100%">
        <Group gap={4} justify="space-between" wrap="nowrap">
          <Group gap={4} wrap="nowrap">
            {unavailable && (
              <ThemeIcon color="red" w="auto" size="sm" px={4} mr={8}>
                <Group gap={4}>
                  <IconAlertTriangle size={16} strokeWidth={3} />
                  <Text size="xs" weight={500}>
                    Unavailable
                  </Text>
                </Group>
              </ThemeIcon>
            )}
            <Text
              component={Link}
              style={{ cursor: 'pointer' }}
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
            {'epochDetails' in resource && (
              <Badge size="sm" color="dark.5" variant="filled" miw="42px">
                {resource.epochDetails?.epochNumber}
              </Badge>
            )}

            {(resource.availability === Availability.Private || !!resource.epochDetails) && (
              <Tooltip label="This resource is private" position="top" withArrow>
                <ActionIcon size={18} color="dark.5" variant="filled">
                  <IconLock size={14} />
                </ActionIcon>
              </Tooltip>
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
                    <IconBolt className="text-dark-9" fill="currentColor" size={16} />
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
              className="flex-1"
              value={resource.strength}
              onChange={(strength) => onUpdate({ ...resource, strength: strength ?? 1 })}
              min={!isSameMinMaxStrength ? resource.minStrength : -1}
              max={!isSameMinMaxStrength ? resource.maxStrength : 2}
              step={0.05}
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
