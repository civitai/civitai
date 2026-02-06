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
 *
 * When `versions` prop is provided, displays a version selector (segmented control) for
 * switching between model versions (e.g., Flux Dev/Schnell, Wan 2.1/2.2).
 */

import React, { useEffect, useMemo } from 'react';
import type { InputWrapperProps } from '@mantine/core';
import { Button, Input } from '@mantine/core';
import { IconPlus, IconRotate, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { openResourceSelectModal } from '~/components/Dialog/triggers/resource-select';
import type {
  ResourceSelectOptions,
  ResourceSelectSource,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useResourceDataContext, useResourceData } from './ResourceDataProvider';
import { OverflowSegmentedControl } from './OverflowSegmentedControl';
import {
  ResourceItemContent,
  getResourceStatus,
  getStatusClasses,
  isResourceDisabled,
} from './ResourceItemContent';
import {
  needsHydration,
  resolveResourceOptions,
  ResourceCardSkeleton,
  type ResourceData,
  type ResourceSelectValue,
  type PartialResourceValue,
} from './resource-select.utils';

// Re-export types for consumers
export type { ResourceSelectValue, PartialResourceValue } from './resource-select.utils';

// =============================================================================
// Types
// =============================================================================

/** Version option for the version selector */
export interface VersionOption {
  label: string;
  value: number;
  /** Optional baseModel override (for backwards compatibility with hardcoded values) */
  baseModel?: string;
}

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
  /** Callback to revert to default model (shown when resource is disabled) */
  onRevertToDefault?: () => void;
  /**
   * Version options for models with multiple versions (e.g., Flux Dev/Schnell, Wan 2.1/2.2).
   * When provided and the current value's ID matches one of the versions, a segmented
   * control is shown to switch between versions.
   */
  versions?: VersionOption[];
  /** Maximum visible options in version selector before overflow (default: 5) */
  versionsMaxVisible?: number;
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
  onRevertToDefault?: () => void;
  disabled?: boolean;
  allowSwap?: boolean;
  options?: ResourceSelectOptions;
}

function ResourceCard({
  resource,
  value,
  onChange,
  onSwap,
  onRemove,
  onRevertToDefault,
  disabled,
  allowSwap = true,
  options,
}: ResourceCardProps) {
  const status = getResourceStatus(resource, options);
  const statusClasses = getStatusClasses(status);
  const resourceIsDisabled = isResourceDisabled(status);

  return (
    <div
      className={clsx(
        'rounded-lg border border-solid border-gray-3 dark:border-dark-4',
        'bg-gray-0 dark:bg-dark-6',
        'p-2',
        statusClasses.border,
        statusClasses.background
      )}
    >
      <ResourceItemContent
        resource={resource}
        strengthValue={value.strength ?? resource.strength}
        onStrengthChange={
          // Don't allow strength changes for disabled resources
          onChange && !resourceIsDisabled
            ? (strength) => onChange({ ...value, strength })
            : undefined
        }
        disabled={disabled}
        options={options}
        actions={
          <>
            {/* Show Revert to Default button when resource is disabled */}
            {resourceIsDisabled && onRevertToDefault && (
              <Button
                variant="light"
                radius="xl"
                size="compact-xs"
                onClick={onRevertToDefault}
                leftSection={<IconRotate size={14} />}
              >
                Default
              </Button>
            )}
            {/* Show Swap button (even for disabled resources so user can swap to compatible one) */}
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
          </>
        }
      />
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
  onRevertToDefault,
  versions,
  versionsMaxVisible = 5,
  ...inputWrapperProps
}: ResourceSelectInputProps) {
  const { registerResourceId, unregisterResourceId, getResourceData } = useResourceDataContext();

  // Fetch resource data for display (registration handled by form provider)
  // If value is already hydrated, use it directly; otherwise fetch via provider
  const { data: fetchedData, isLoading } = useResourceData(value?.id);

  // Use fetched data for display info, but preserve form value's strength
  const resourceData =
    fetchedData ?? (value && !needsHydration(value) ? (value as ResourceData) : undefined);

  // Build options from resourceType if provided
  const resolvedOptions = resolveResourceOptions(options, resourceType);

  // Register all version IDs for pre-fetching so baseModel data is available when switching
  const versionIds = useMemo(() => versions?.map((v) => v.value) ?? [], [versions]);
  useEffect(() => {
    if (versionIds.length === 0) return;
    versionIds.forEach(registerResourceId);
    return () => {
      versionIds.forEach(unregisterResourceId);
    };
  }, [versionIds, registerResourceId, unregisterResourceId]);

  // Check if current value is one of the versions (show version selector)
  const showVersionSelector = value?.id !== undefined && versionIds.includes(value.id);

  // Handle version selection from segmented control
  const handleVersionChange = (stringId: string) => {
    const numericId = Number(stringId);
    const versionResourceData = getResourceData(numericId);
    onChange?.(versionResourceData);
  };

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

  // Render loading state when fetching data or waiting for hydration
  if (!resourceData) {
    return (
      <Input.Wrapper {...inputWrapperProps}>
        <ResourceCardSkeleton />
      </Input.Wrapper>
    );
  }

  // Render selected resource
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
        onRevertToDefault={onRevertToDefault}
        disabled={disabled}
        allowSwap={allowSwap}
        options={options}
      />
      {/* Version selector for models with multiple versions */}
      {showVersionSelector && versions && (
        <OverflowSegmentedControl
          value={value?.id?.toString()}
          onChange={handleVersionChange}
          options={versions.map(({ label, value: versionValue }) => ({
            label,
            value: versionValue.toString(),
          }))}
          maxVisible={versionsMaxVisible}
          className="mt-2"
        />
      )}
    </Input.Wrapper>
  );
}
