import type { GroupProps } from '@mantine/core';
import {
  Anchor,
  Badge,
  Button,
  Group,
  HoverCard,
  Overlay,
  Paper,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconFlask2,
  IconLock,
  IconReplace,
  IconShield,
  IconWeight,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useStepContext } from '~/components/Generation/Providers/StepProvider';
import type { ResourceSelectSource } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ModelVersionPopularity } from '~/components/Model/ModelVersions/ModelVersionPopularity';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { useAppContext } from '~/providers/AppProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { GenerationResourceSchema } from '~/server/schema/generation.schema';
import type { BaseModelGroup } from '~/shared/constants/base-model.constants';
import { getGenerationBaseModelResourceOptions } from '~/shared/constants/base-model.constants';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import { Availability, ModelType } from '~/shared/utils/prisma/enums';
import { generationPanel } from '~/store/generation.store';

/**
 * Determine if a link to the model page should be shown for this resource.
 * Show link if resource is publicly accessible OR user owns it.
 * Uses optional fields (isPrivate, isOwnedByUser) that may come from newer data sources.
 */
function shouldShowModelLink(
  resource: GenerationResourceSchema & { isPrivate?: boolean; isOwnedByUser?: boolean }
): boolean {
  return resource.isOwnedByUser === true || resource.isPrivate !== true;
}

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
  isPartiallySupported?: boolean;
  isPreview?: boolean;
};

export const ResourceSelectCard = (props: Props) => {
  const stepContext = useStepContext();
  const isCheckpoint = props.resource.model.type === ModelType.Checkpoint;
  const { resource } = props;
  const isPartiallySupported = useMemo(() => {
    if (!stepContext?.baseModel) return false;
    const resources = getGenerationBaseModelResourceOptions(
      stepContext.baseModel as BaseModelGroup
    );
    return !!resources?.some((r) => {
      const baseModelType = getBaseModelSetType(resource.baseModel);
      return (
        'partialSupport' in r &&
        (r.partialSupport as string[])
          .map((x) => getBaseModelSetType(x))
          ?.includes(baseModelType) &&
        !(r.baseModels as string[]).includes(baseModelType as string)
      );
    });
  }, [stepContext?.baseModel, resource.baseModel]);

  return (
    <div className="relative">
      {props.disabled && (
        <Overlay blur={3} zIndex={10} className="bg-white dark:bg-dark-7" opacity={0.8} />
      )}
      {isCheckpoint || props.showAsCheckpoint ? (
        <CheckpointInfo {...props} isPartiallySupported={isPartiallySupported} />
      ) : (
        <ResourceInfoCard {...props} isPartiallySupported={isPartiallySupported} />
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
  isPartiallySupported,
  isPreview,
}: Props) {
  const features = useFeatureFlags();
  const unavailable = selectSource !== 'generation' ? false : resource.canGenerate !== true;
  const { domain } = useAppContext();
  const showLink = shouldShowModelLink(resource);

  return (
    <Group
      gap="xs"
      justify={groupPosition ?? 'space-between'}
      wrap="nowrap"
      className={clsx('px-3 py-1.5', { ['bg-yellow-5/20']: isPartiallySupported })}
    >
      <Group gap={4} wrap="nowrap">
        {unavailable ? (
          <ThemeIcon color="red" w="auto" size="sm" px={4} mr={8}>
            <Group gap={4}>
              <IconAlertTriangle size={16} strokeWidth={3} />
              <Text size="xs" fw={500}>
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
          <div className="flex items-center gap-2">
            {showLink ? (
              <Text
                component={Link}
                className="cursor-pointer text-black dark:text-white"
                style={{ overflowWrap: 'anywhere' }}
                href={`/models/${resource.model.id}?modelVersionId=${resource.id}`}
                rel="nofollow noindex"
                lineClamp={1}
                fw={590}
                data-testid="selected-gen-resource-name"
              >
                {resource.model.name}
              </Text>
            ) : (
              <Text
                className="text-black dark:text-white"
                style={{ overflowWrap: 'anywhere' }}
                lineClamp={1}
                fw={590}
                data-testid="selected-gen-resource-name"
              >
                {resource.model.name}
              </Text>
            )}
            {!domain.green && (resource.model.sfwOnly || resource.model.minor) && (
              <HoverCard position="bottom" withArrow>
                <HoverCard.Target>
                  <LegacyActionIcon size={18} color="green.5" variant="filled">
                    <IconShield size={14} />
                  </LegacyActionIcon>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Text size="sm">This resource cannot be used to generate mature content</Text>
                </HoverCard.Dropdown>
              </HoverCard>
            )}
            {isPreview && (
              <HoverCard position="bottom" withArrow>
                <HoverCard.Target>
                  <LegacyActionIcon size={18} color="orange.5" variant="filled">
                    <IconFlask2 size={14} />
                  </LegacyActionIcon>
                </HoverCard.Target>
                <HoverCard.Dropdown maw={350}>
                  <Text size="sm">
                    This resource is a preview version and may have limited functionality.
                  </Text>
                </HoverCard.Dropdown>
              </HoverCard>
            )}
          </div>
          {!hideVersion && (
            <Text size="sm" c="dimmed">
              {resource.name}
            </Text>
          )}
          {selectSource === 'generation' && features.modelVersionPopularity && (
            <ModelVersionPopularity
              versionId={resource.id}
              isCheckpoint={resource.model.type === ModelType.Checkpoint}
              listenForUpdates={true}
            />
          )}
        </Stack>
      </Group>
      {onRemove ? (
        <LegacyActionIcon size="sm" variant="subtle" onClick={() => onRemove(resource.id)}>
          <IconX size={20} />
        </LegacyActionIcon>
      ) : (
        <Button variant="light" radius="xl" onClick={onSwap} size="compact-sm">
          <Group gap={4} wrap="nowrap">
            <IconReplace size={16} />
            <Text size="sm" fw={500}>
              Swap
            </Text>
          </Group>
        </Button>
      )}
    </Group>
  );
}

function ResourceInfoCard({
  resource,
  onRemove,
  onUpdate,
  selectSource,
  isPartiallySupported,
}: Props) {
  const hasStrength = ['LORA', 'LoCon', 'DoRA'].includes(resource.model.type);
  const isSameMinMaxStrength = resource.minStrength === resource.maxStrength;
  const unavailable = selectSource !== 'generation' ? false : !resource.canGenerate;
  const { domain } = useAppContext();
  const showLink = shouldShowModelLink(resource);

  return (
    <Group
      gap="xs"
      justify="space-between"
      wrap="nowrap"
      className={clsx('px-3 py-1.5', { ['bg-yellow-5/20']: isPartiallySupported })}
    >
      <Stack gap={4} w="100%">
        <Group gap={4} justify="space-between" wrap="nowrap">
          <Group gap={4} wrap="nowrap">
            {unavailable && (
              <ThemeIcon color="red" w="auto" size="sm" px={4} mr={8}>
                <Group gap={4}>
                  <IconAlertTriangle size={16} strokeWidth={3} />
                  <Text size="xs" fw={500}>
                    Unavailable
                  </Text>
                </Group>
              </ThemeIcon>
            )}
            {showLink ? (
              <Text
                component={Link}
                style={{ cursor: 'pointer' }}
                href={`/models/${resource.model.id}?modelVersionId=${resource.id}`}
                onClick={() => generationPanel.close()}
                rel="nofollow noindex"
                size="sm"
                lineClamp={1}
                fw={590}
              >
                {resource.model.name}
              </Text>
            ) : (
              <Text size="sm" lineClamp={1} fw={590}>
                {resource.model.name}
              </Text>
            )}
            {!domain.green && (resource.model.sfwOnly || resource.model.minor) && (
              <HoverCard position="bottom" withArrow>
                <HoverCard.Target>
                  <LegacyActionIcon size={18} color="green.5" variant="filled">
                    <IconShield size={14} />
                  </LegacyActionIcon>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Text size="sm">This resource cannot be used to generate mature content</Text>
                </HoverCard.Dropdown>
              </HoverCard>
            )}
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
              <HoverCard position="bottom" withArrow>
                <HoverCard.Target>
                  <LegacyActionIcon size={18} color="dark.5" variant="filled">
                    <IconLock size={14} />
                  </LegacyActionIcon>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Text size="sm">This resource is private</Text>
                </HoverCard.Dropdown>
              </HoverCard>
            )}

            {resource.additionalResourceCost && selectSource === 'generation' && (
              <HoverCard position="bottom" withArrow width={200}>
                <HoverCard.Target>
                  <LegacyActionIcon size={18} color="blue" variant="filled">
                    <IconWeight size={14} />
                  </LegacyActionIcon>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Text size="sm">
                    This resource carries an additional{' '}
                    <Anchor component={Link} href="/articles/7929">
                      buzz cost
                    </Anchor>
                  </Text>
                </HoverCard.Dropdown>
              </HoverCard>
            )}
            {resource.earlyAccessEndsAt && (
              <HoverCard position="bottom" withArrow width={200}>
                <HoverCard.Target>
                  <LegacyActionIcon size={18} color="yellow.7" variant="filled">
                    <IconBolt className="text-dark-9" fill="currentColor" size={16} />
                  </LegacyActionIcon>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Text size="sm">This resource is in early access</Text>
                </HoverCard.Dropdown>
              </HoverCard>
            )}
            {isPartiallySupported && (
              <HoverCard position="bottom" withArrow width={200}>
                <HoverCard.Target>
                  <LegacyActionIcon size={18} color="yellow.7" variant="filled">
                    <IconAlertTriangle size={16} />
                  </LegacyActionIcon>
                </HoverCard.Target>
                <HoverCard.Dropdown>
                  <Text size="sm">
                    This resource may not be fully supported for generation with the current base
                    model
                  </Text>
                </HoverCard.Dropdown>
              </HoverCard>
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
        <LegacyActionIcon size="sm" variant="subtle" onClick={() => onRemove(resource.id)}>
          <IconX size={20} />
        </LegacyActionIcon>
      )}
    </Group>
  );
}
