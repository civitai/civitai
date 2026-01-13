/**
 * ResourceSelectMultipleInput
 *
 * A form input component for selecting multiple resources (model versions).
 * Uses the ResourceDataProvider to batch-fetch resource data.
 *
 * Value format: Array<ResourceSelectValue> (hydrated objects)
 *
 * The input accepts minimal values (just { id }) and hydrates them with full resource data
 * when fetched. This allows URL params to pass just ids while handlers get full context.
 */

import type { InputWrapperProps } from '@mantine/core';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Collapse,
  Divider,
  Group,
  HoverCard,
  Input,
  Skeleton,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle, IconChevronDown, IconPlus, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import type {
  ResourceSelectOptions,
  ResourceSelectSource,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { useResourceDataContext } from './ResourceDataProvider';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import { getDisplayName } from '~/utils/string-helpers';

/**
 * Value type for ResourceSelectMultipleInput - stores full GenerationResource objects.
 * Input schema accepts just { id } and the component hydrates to full resource.
 */
export type ResourceSelectValue = GenerationResource;

/** Partial value that may need hydration (only has id) */
type PartialResourceValue = Partial<ResourceSelectValue> & { id: number };

/**
 * Helper to check if a value needs hydration.
 * A value needs hydration if it only has an id (came from URL param or minimal input).
 */
function needsHydration(value: PartialResourceValue): boolean {
  // If we're missing the model object, we need to hydrate
  return !('model' in value) || !value.model;
}

/**
 * Helper to check if a value is fully hydrated (has all required data).
 * Used to display resource data from localStorage before fetch completes.
 */
function isFullyHydrated(value: PartialResourceValue): value is ResourceSelectValue {
  return 'model' in value && !!value.model;
}

// =============================================================================
// Types
// =============================================================================

export interface ResourceSelectMultipleInputProps
  extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  /** Value can be full GenerationResource[] or partial with just { id }[] for hydration */
  value?: PartialResourceValue[];
  onChange?: (value: PartialResourceValue[]) => void;
  /** Maximum number of resources that can be selected */
  limit?: number;
  /** Label for the add button */
  buttonLabel?: React.ReactNode;
  /** Title for the resource selection modal */
  modalTitle?: React.ReactNode;
  /** Options for filtering available resources */
  options?: ResourceSelectOptions;
  /** Source context for resource selection */
  selectSource?: ResourceSelectSource;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Resource type to filter by */
  resourceType?: 'Checkpoint' | 'LORA' | 'VAE' | 'TextualInversion';
  /** Whether to hide the add button */
  hideButton?: boolean;
  /** localStorage key for persisting expanded/collapsed state */
  storageKey?: string;
}

// =============================================================================
// Resource Item Component
// =============================================================================

interface ResourceItemProps {
  resourceValue: PartialResourceValue;
  resource: (GenerationResource & { air: string }) | undefined;
  onChange: (value: ResourceSelectValue) => void;
  onRemove: () => void;
  disabled?: boolean;
  index: number;
  options?: ResourceSelectOptions;
}

/**
 * Check compatibility of a resource's baseModel against the options.resources config.
 * Returns 'full' if in baseModels, 'partial' if in partialSupport, null if neither.
 */
function getResourceCompatibility(
  resourceBaseModel: string | undefined,
  resourceType: string,
  options?: ResourceSelectOptions
): 'full' | 'partial' | null {
  if (!resourceBaseModel || !options?.resources) return 'full'; // No options = assume compatible

  const resourceConfig = options.resources.find((r) => r.type === resourceType);
  if (!resourceConfig) return 'full'; // No config for this type = assume compatible

  if (resourceConfig.baseModels?.includes(resourceBaseModel)) return 'full';
  if (resourceConfig.partialSupport?.includes(resourceBaseModel)) return 'partial';
  return null; // Not in either list = incompatible
}

function ResourceItem({
  resourceValue,
  resource,
  onChange,
  onRemove,
  disabled,
  index,
  options,
}: ResourceItemProps) {
  // Use fetched resource if available, otherwise use hydrated value from localStorage
  const displayResource = resource ?? (isFullyHydrated(resourceValue) ? resourceValue : undefined);
  const isOdd = index % 2 === 1;

  // Only show loading state if we have no data at all (neither fetched nor from localStorage)
  if (!displayResource) {
    return (
      <div
        className={clsx('px-3 py-1.5', {
          'bg-gray-2 dark:bg-dark-5': isOdd,
        })}
      >
        <Group gap="xs" justify="space-between" wrap="nowrap">
          <Skeleton height={20} width="60%" />
          <Skeleton height={24} width={24} radius="sm" />
        </Group>
      </div>
    );
  }

  const hasStrength = ['LORA', 'LoCon', 'DoRA'].includes(displayResource.model.type);
  const isSameMinMaxStrength = displayResource.minStrength === displayResource.maxStrength;

  const compatibility = getResourceCompatibility(
    displayResource.baseModel,
    displayResource.model.type,
    options
  );
  const isPartiallyCompatible = compatibility === 'partial';
  const isIncompatible = compatibility === null;

  return (
    <div
      className={clsx('px-3 py-1.5', {
        'bg-gray-2 dark:bg-dark-5': isOdd && !isPartiallyCompatible && !isIncompatible,
        'bg-yellow-1 dark:bg-yellow-9/20': isPartiallyCompatible,
        'bg-red-1 dark:bg-red-9/20': isIncompatible,
      })}
    >
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Group gap={4} wrap="nowrap" className="min-w-0 flex-1">
          <Text size="sm" lineClamp={1} fw={590} className="truncate">
            {displayResource.model.name}
          </Text>
          {displayResource.model.name.toLowerCase() !== displayResource.name.toLowerCase() && (
            <Text size="xs" c="dimmed" className="shrink-0">
              ({displayResource.name})
            </Text>
          )}
          {isPartiallyCompatible && (
            <HoverCard position="bottom" withArrow width={200}>
              <HoverCard.Target>
                <ThemeIcon size={18} color="yellow.7" variant="filled" className="shrink-0">
                  <IconAlertTriangle size={14} />
                </ThemeIcon>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Text size="sm">
                  This resource may not be fully supported with the current base model
                </Text>
              </HoverCard.Dropdown>
            </HoverCard>
          )}
          {isIncompatible && (
            <HoverCard position="bottom" withArrow width={200}>
              <HoverCard.Target>
                <ThemeIcon size={18} color="red" variant="filled" className="shrink-0">
                  <IconAlertTriangle size={14} />
                </ThemeIcon>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Text size="sm">This resource is not compatible with the current base model</Text>
              </HoverCard.Dropdown>
            </HoverCard>
          )}
        </Group>
        <ActionIcon size="sm" variant="subtle" onClick={onRemove} disabled={disabled}>
          <IconX size={16} />
        </ActionIcon>
      </Group>
      {hasStrength && (
        <div className="mt-1 flex w-full items-center gap-2">
          <NumberSlider
            className="flex-1"
            value={resourceValue.strength ?? displayResource.strength ?? 1}
            onChange={(strength) => {
              // Use the display resource as base, with updated strength
              onChange({ ...displayResource, strength: strength ?? 1 });
            }}
            min={!isSameMinMaxStrength ? displayResource.minStrength : -1}
            max={!isSameMinMaxStrength ? displayResource.maxStrength : 2}
            step={0.05}
            reverse
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Hook for batch resource data
// =============================================================================

function useResourcesData(ids: number[]) {
  const { registerResourceId, unregisterResourceId, getResourceData } = useResourceDataContext();

  // Register all IDs on mount
  useEffect(() => {
    ids.forEach(registerResourceId);
    return () => {
      ids.forEach(unregisterResourceId);
    };
  }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Get resource data for all IDs
  const resources = useMemo(() => {
    const map = new Map<number, (GenerationResource & { air: string }) | undefined>();
    for (const id of ids) {
      map.set(id, getResourceData(id));
    }
    return map;
  }, [ids, getResourceData]);

  return { resources };
}

// =============================================================================
// Component
// =============================================================================

export function ResourceSelectMultipleInput({
  value = [],
  onChange,
  limit,
  buttonLabel = 'Add Resource',
  modalTitle,
  options = {},
  selectSource = 'generation',
  disabled,
  resourceType,
  hideButton = false,
  label,
  storageKey,
  ...inputWrapperProps
}: ResourceSelectMultipleInputProps) {
  // Accordion state - persisted to localStorage if storageKey provided, otherwise local state
  const [storedOpened, setStoredOpened] = useLocalStorage<boolean>({
    key: storageKey ?? '__unused__',
    defaultValue: value.length > 0,
  });
  const [localOpened, setLocalOpened] = useState(value.length > 0);

  const opened = storageKey ? storedOpened : localOpened;
  const toggle = () => {
    if (storageKey) {
      setStoredOpened((prev) => !prev);
    } else {
      setLocalOpened((prev) => !prev);
    }
  };

  // Get all resource IDs
  const resourceIds = useMemo(() => value.map((v) => v.id), [value]);

  // Batch fetch resource data
  const { resources } = useResourcesData(resourceIds);

  // Track which IDs we've hydrated to avoid infinite loops
  const hydratedIdsRef = useRef<Set<number>>(new Set());

  // Hydrate values when resource data is fetched
  useEffect(() => {
    if (!onChange) return;

    // Check if any values need hydration
    const idsToHydrate = new Set<number>();
    for (const v of value) {
      const resource = resources.get(v.id);
      if (resource && needsHydration(v) && !hydratedIdsRef.current.has(v.id)) {
        idsToHydrate.add(v.id);
        hydratedIdsRef.current.add(v.id);
      }
    }

    if (idsToHydrate.size > 0) {
      const hydratedValues = value.map((v): ResourceSelectValue => {
        const resource = resources.get(v.id);
        if (resource && idsToHydrate.has(v.id)) {
          // Store the full resource, preserving any existing strength override
          return {
            ...resource,
            strength: v.strength ?? resource.strength,
          };
        }
        // Already hydrated - cast to full type
        return v as ResourceSelectValue;
      });
      onChange(hydratedValues);
    }
  }, [resources, value, onChange]);

  // Reset hydration tracking when value array changes (different IDs)
  useEffect(() => {
    const currentIds = new Set(value.map((v) => v.id));
    // Remove IDs that are no longer in value from the hydrated set
    for (const id of hydratedIdsRef.current) {
      if (!currentIds.has(id)) {
        hydratedIdsRef.current.delete(id);
      }
    }
  }, [resourceIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build options from resourceType if provided, but don't overwrite existing resources
  // (deriveProps may set options.resources with baseModels filtering)
  const resolvedOptions: ResourceSelectOptions =
    resourceType && !options?.resources?.length
      ? { ...options, resources: [{ type: resourceType }] }
      : options;

  // Group resources by type
  const groups = useMemo(() => {
    const groupMap = new Map<
      string,
      { value: PartialResourceValue; resource?: GenerationResource & { air: string } }[]
    >();

    for (const resourceValue of value) {
      const resource = resources.get(resourceValue.id);
      // Get type from fetched resource, or from hydrated value's model, or fallback to Unknown
      const type =
        resource?.model.type ?? (resourceValue as ResourceSelectValue).model?.type ?? 'Unknown';
      const group = groupMap.get(type) ?? [];
      group.push({ value: resourceValue, resource });
      groupMap.set(type, group);
    }

    return Array.from(groupMap.entries()).map(([type, items]) => ({
      type,
      label: getDisplayName(type),
      items,
    }));
  }, [value, resources]);

  const canAdd = !limit || value.length < limit;

  const handleOpenModal = () => {
    openResourceSelectModal({
      title: modalTitle ?? buttonLabel,
      onSelect: (resource) => {
        // Store the full GenerationResource
        // Cast existing values since they should be hydrated by now
        onChange?.([...(value as ResourceSelectValue[]), resource]);
      },
      options: {
        ...resolvedOptions,
        excludeIds: [...(resolvedOptions.excludeIds ?? []), ...resourceIds],
      },
      selectSource,
    });
  };

  const handleRemove = (id: number) => {
    onChange?.(value.filter((v) => v.id !== id) as ResourceSelectValue[]);
  };

  const handleUpdate = (updated: ResourceSelectValue) => {
    onChange?.(value.map((v) => (v.id === updated.id ? updated : v)) as ResourceSelectValue[]);
  };

  const hasResources = value.length > 0;
  const countDisplay = limit ? `${value.length}/${limit}` : `${value.length}`;

  return (
    <Input.Wrapper {...inputWrapperProps} label={undefined}>
      <Card withBorder padding={0}>
        {/* Header section - only show bottom border when content is expanded */}
        <Card.Section withBorder={opened && hasResources} inheritPadding py="xs" px="sm">
          <Group justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap">
              {label && (
                <Input.Label component="span" fw={500}>
                  {label}
                </Input.Label>
              )}

              <Badge size="sm" variant="light" color="gray">
                {countDisplay}
              </Badge>
            </Group>

            <Group gap="xs" wrap="nowrap">
              {canAdd && !hideButton && (
                <Button
                  variant="light"
                  size="compact-xs"
                  leftSection={<IconPlus size={14} />}
                  onClick={handleOpenModal}
                  disabled={disabled}
                >
                  Add
                </Button>
              )}

              <ActionIcon
                variant="subtle"
                size="sm"
                onClick={toggle}
                className={clsx('transition-transform', { 'rotate-180': opened })}
              >
                <IconChevronDown size={16} />
              </ActionIcon>
            </Group>
          </Group>
        </Card.Section>

        {/* Content section - collapsible resource list */}
        <Collapse in={opened}>
          <Card.Section>
            {hasResources ? (
              <div className="flex flex-col">
                {groups.map((group, index) => (
                  <div key={group.type}>
                    {index !== 0 && <Divider />}
                    {groups.length > 1 && (
                      <Text size="xs" c="dimmed" fw={500} className="px-3 pb-1 pt-2">
                        {group.label}
                      </Text>
                    )}
                    <div className="flex flex-col">
                      {group.items.map(({ value: resourceValue, resource }, itemIndex) => (
                        <ResourceItem
                          key={resourceValue.id}
                          resourceValue={resourceValue}
                          resource={resource}
                          onChange={handleUpdate}
                          onRemove={() => handleRemove(resourceValue.id)}
                          disabled={disabled}
                          index={itemIndex}
                          options={options}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <Text c="dimmed" size="sm" className="px-3 py-2">
                No resources selected
              </Text>
            )}
          </Card.Section>
        </Collapse>
      </Card>
    </Input.Wrapper>
  );
}
