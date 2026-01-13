/**
 * ResourceSelectInput
 *
 * A form input component for selecting a single resource (model version).
 * Uses the ResourceDataProvider to batch-fetch resource data.
 *
 * Value format: ResourceSelectValue (hydrated object with id, strength, baseModel, etc.)
 *
 * The input accepts minimal values (just { id }) and hydrates them with full resource data
 * when fetched. This allows URL params to pass just an id while handlers get full context.
 */

import { useEffect, useRef } from 'react';
import type { InputWrapperProps } from '@mantine/core';
import { Button, Group, HoverCard, Input, Skeleton, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconPlus, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import type {
  ResourceSelectOptions,
  ResourceSelectSource,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { useResourceData } from './ResourceDataProvider';
import type { GenerationResource } from '~/server/services/generation/generation.service';

/** Resource data as returned by ResourceDataProvider (GenerationResource with air field) */
type ResourceData = GenerationResource & { air: string };

/**
 * Value type for ResourceSelectInput - stores the full GenerationResource.
 * Input schema accepts just an id (number) and the component hydrates to full resource.
 */
export type ResourceSelectValue = GenerationResource;

/**
 * Partial resource value that can be passed to the input.
 * This matches what DataGraph validation schema outputs.
 */
export type PartialResourceValue = Partial<GenerationResource> & { id: number };

/**
 * Helper to check if a value needs hydration.
 * A value needs hydration if it's missing essential fields like name or model.name.
 * This can happen when the value came from URL params, minimal input, or DataGraph defaults.
 */
function needsHydration(value: Partial<ResourceSelectValue> | undefined): boolean {
  if (!value) return false;
  // If we're missing name or model.name, we need to hydrate
  // DataGraph defaults only include { id, baseModel, model: { type } } - no name fields
  return !('name' in value) || !value.name || !value.model?.name;
}

// =============================================================================
// Types
// =============================================================================

export interface ResourceSelectInputProps extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  /** Value can be a full GenerationResource or partial with just { id } for hydration */
  value?: PartialResourceValue;
  onChange?: (value: PartialResourceValue | undefined) => void;
  /** Label for the button when no resource is selected */
  buttonLabel?: React.ReactNode;
  /** Title for the resource selection modal */
  modalTitle?: React.ReactNode;
  /** Options for filtering available resources */
  options?: ResourceSelectOptions;
  /** Whether to allow removing the selected resource */
  allowRemove?: boolean;
  /** Whether to allow swapping the selected resource (set to false to lock the resource) */
  allowSwap?: boolean;
  /** Source context for resource selection */
  selectSource?: ResourceSelectSource;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Resource type to filter by (e.g., 'LORA', 'Checkpoint') */
  resourceType?: 'Checkpoint' | 'LORA' | 'VAE' | 'TextualInversion';
}

// =============================================================================
// Resource Card (displays selected resource)
// =============================================================================

interface ResourceCardProps {
  resource: ResourceData;
  value: ResourceSelectValue;
  onChange?: (value: ResourceSelectValue) => void;
  onSwap: () => void;
  onRemove?: () => void;
  disabled?: boolean;
  allowSwap?: boolean;
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

  if (!resourceConfig.baseModels && !resourceConfig.partialSupport) return 'full'; // No restrictions
  if (resourceConfig.baseModels?.includes(resourceBaseModel)) return 'full';
  if (resourceConfig.partialSupport?.includes(resourceBaseModel)) return 'partial';
  return null; // Not in either list = incompatible
}

function ResourceCard({
  resource,
  value,
  onChange,
  onSwap,
  onRemove,
  disabled,
  allowSwap = true,
  options,
}: ResourceCardProps) {
  const hasStrength = ['LORA', 'LoCon', 'DoRA'].includes(resource.model.type);
  const isSameMinMaxStrength = resource.minStrength === resource.maxStrength;

  const compatibility = getResourceCompatibility(resource.baseModel, resource.model.type, options);
  const isPartiallyCompatible = compatibility === 'partial';
  const isIncompatible = compatibility === null;

  return (
    <div
      className={clsx(
        'rounded-lg border border-solid border-gray-3 dark:border-dark-4',
        'bg-gray-0 dark:bg-dark-6',
        'p-2',
        {
          'border-yellow-5 bg-yellow-1 dark:bg-yellow-9/20': isPartiallyCompatible,
          'border-red-5 bg-red-1 dark:bg-red-9/20': isIncompatible,
        }
      )}
    >
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Group gap={4} wrap="nowrap" className="min-w-0 flex-1">
          <Text size="sm" lineClamp={1} fw={590} className="truncate">
            {resource.model.name}
          </Text>
          {resource.model.name.toLowerCase() !== resource.name.toLowerCase() && (
            <Text size="xs" c="dimmed" className="shrink-0">
              ({resource.name})
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
        <Group gap={4} className="shrink-0">
          {allowSwap && (
            <Button
              variant="light"
              radius="xl"
              size="compact-xs"
              onClick={onSwap}
              disabled={disabled}
            >
              Swap
            </Button>
          )}
          {onRemove && (
            <LegacyActionIcon size="sm" variant="subtle" onClick={onRemove} disabled={disabled}>
              <IconX size={16} />
            </LegacyActionIcon>
          )}
        </Group>
      </Group>
      {hasStrength && onChange && (
        <div className="mt-2 flex w-full items-center gap-2">
          <NumberSlider
            className="flex-1"
            value={value.strength ?? resource.strength ?? 1}
            onChange={(strength) => onChange({ ...value, strength: strength ?? 1 })}
            min={!isSameMinMaxStrength ? resource.minStrength : -1}
            max={!isSameMinMaxStrength ? resource.maxStrength : 2}
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
// Loading State
// =============================================================================

function ResourceCardSkeleton() {
  return (
    <div className="rounded-lg border border-solid border-gray-3 bg-gray-0 p-2 dark:border-dark-4 dark:bg-dark-6">
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Skeleton height={20} width="60%" />
        <Group gap={4}>
          <Skeleton height={24} width={50} radius="xl" />
          <Skeleton height={24} width={24} radius="sm" />
        </Group>
      </Group>
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

export function ResourceSelectInput({
  value,
  onChange,
  buttonLabel = 'Add Resource',
  modalTitle,
  options = {},
  allowRemove = true,
  allowSwap = true,
  selectSource = 'generation',
  disabled,
  resourceType,
  ...inputWrapperProps
}: ResourceSelectInputProps) {
  // Only fetch if the value needs hydration (missing full resource data)
  const shouldFetch = needsHydration(value);
  const { data: fetchedData, isLoading } = useResourceData(shouldFetch ? value?.id : undefined);

  // Use fetched data if we needed hydration, otherwise use the value directly
  const resourceData = shouldFetch ? fetchedData : (value as ResourceData | undefined);

  // Track if we've already hydrated to avoid infinite loops
  const hasHydratedRef = useRef(false);

  // Hydrate the value when resource data is fetched and value needs hydration
  useEffect(() => {
    if (resourceData && value && needsHydration(value) && !hasHydratedRef.current && onChange) {
      hasHydratedRef.current = true;
      // Store the full resource, preserving any existing strength override
      const hydrated: ResourceSelectValue = {
        ...resourceData,
        strength: value.strength ?? resourceData.strength,
      };
      onChange(hydrated);
    }
  }, [resourceData, value, onChange]);

  // Reset hydration flag when id changes
  useEffect(() => {
    hasHydratedRef.current = false;
  }, [value?.id]);

  // Build options from resourceType if provided, but don't overwrite existing resources
  // (deriveProps may set options.resources with baseModels filtering)
  const resolvedOptions: ResourceSelectOptions =
    resourceType && !options?.resources?.length
      ? { ...options, resources: [{ type: resourceType }] }
      : options;

  const handleOpenResourceSearch = () => {
    openResourceSelectModal({
      title: modalTitle ?? buttonLabel,
      onSelect: (resource) => {
        // Store the full GenerationResource
        onChange?.(resource);
      },
      options: resolvedOptions,
      selectSource,
    });
  };

  const handleRemove = () => {
    onChange?.(undefined);
  };

  // Render empty state
  if (!value) {
    return (
      <Input.Wrapper {...inputWrapperProps}>
        <Button
          variant="light"
          leftSection={<IconPlus size={18} />}
          fullWidth
          onClick={handleOpenResourceSearch}
          disabled={disabled}
        >
          {buttonLabel}
        </Button>
      </Input.Wrapper>
    );
  }

  // Render loading state (only when fetching and data not yet available)
  if (shouldFetch && (isLoading || !resourceData)) {
    return (
      <Input.Wrapper {...inputWrapperProps}>
        <ResourceCardSkeleton />
      </Input.Wrapper>
    );
  }

  // If we have a value but no resource data (shouldn't happen, but handle gracefully)
  if (!resourceData) {
    return (
      <Input.Wrapper {...inputWrapperProps}>
        <ResourceCardSkeleton />
      </Input.Wrapper>
    );
  }

  // Render selected resource
  // At this point resourceData exists, so value is either already hydrated or will be on next render
  // Use resourceData as the canonical value, with strength from form state
  const displayValue: ResourceSelectValue = {
    ...resourceData,
    strength: value.strength ?? resourceData.strength,
  };

  return (
    <Input.Wrapper {...inputWrapperProps}>
      <ResourceCard
        resource={resourceData}
        value={displayValue}
        onChange={onChange}
        onSwap={handleOpenResourceSearch}
        onRemove={allowRemove ? handleRemove : undefined}
        disabled={disabled}
        allowSwap={allowSwap}
        options={options}
      />
    </Input.Wrapper>
  );
}
