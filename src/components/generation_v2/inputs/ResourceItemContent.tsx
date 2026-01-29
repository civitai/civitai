/**
 * ResourceItemContent
 *
 * Shared component for displaying resource information in both
 * ResourceSelectInput (card style) and ResourceSelectMultipleInput (list style).
 *
 * Handles:
 * - Model name and version name display
 * - Compatibility warnings (partial, incompatible)
 * - Private resource indicator
 * - Strength slider for LoRA/LoCon/DoRA resources
 */

import { Anchor, Badge, Group, HoverCard, Text, ThemeIcon } from '@mantine/core';
import { IconAlertTriangle, IconBan, IconLock, IconShield } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { NumberSlider } from '~/libs/form/components/NumberSlider';
import { useAppContext } from '~/providers/AppProvider';
import type { GenerationResource } from '~/shared/types/generation.types';
import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';

// =============================================================================
// Types
// =============================================================================

export interface ResourceItemContentProps {
  /** The resource to display */
  resource: GenerationResource;
  /** Current strength value (may differ from resource.strength if user changed it) */
  strengthValue?: number;
  /** Called when strength changes */
  onStrengthChange?: (strength: number) => void;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Options for checking compatibility */
  options?: ResourceSelectOptions;
  /** Additional actions to render on the right side (Swap button, Remove button, etc.) */
  actions?: ReactNode;
  /** Whether to show the strength slider */
  showStrength?: boolean;
}

export type ResourceStatus = 'compatible' | 'partial' | 'incompatible' | 'private' | 'unavailable';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check compatibility of a resource's baseModel against the options.resources config.
 * Returns 'full' if in baseModels, 'partial' if in partialSupport, null if neither.
 */
export function getResourceCompatibility(
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

/**
 * Determine the overall status of a resource for styling and indicators.
 *
 * canGenerate is the definitive "can this user use this resource" flag from the server.
 * When canGenerate is false, we check isPrivate to determine the appropriate UI message.
 *
 * @param resource - The resource to check
 * @param options - Resource select options for compatibility checking
 */
export function getResourceStatus(
  resource: GenerationResource,
  options?: ResourceSelectOptions
): ResourceStatus {
  // canGenerate is the definitive "can this user use this resource" flag
  // If false, determine why for appropriate UI messaging
  if (resource.canGenerate === false) {
    // If private and not owned, show "private" message
    if (resource.isPrivate === true && resource.isOwnedByUser !== true) {
      return 'private';
    }
    // Otherwise show "unavailable" (not covered, invalid status, etc.)
    return 'unavailable';
  }

  // Resource can be generated - check baseModel compatibility (form-state dependent)
  const compatibility = getResourceCompatibility(resource.baseModel, resource.model.type, options);
  if (compatibility === null) return 'incompatible';
  if (compatibility === 'partial') return 'partial';
  return 'compatible';
}

/**
 * Get CSS classes for resource container based on status.
 */
export function getStatusClasses(status: ResourceStatus): {
  border?: string;
  background?: string;
} {
  switch (status) {
    case 'partial':
      return {
        border: 'border-yellow-5',
        background: 'bg-yellow-1 dark:bg-yellow-9/20',
      };
    case 'incompatible':
    case 'private':
    case 'unavailable':
      return {
        border: 'border-red-5',
        background: 'bg-red-1 dark:bg-red-9/20',
      };
    default:
      return {};
  }
}

/**
 * Check if a resource is in a disabled state (cannot be used for generation).
 * Disabled resources are: incompatible, private, or unavailable.
 */
export function isResourceDisabled(status: ResourceStatus): boolean {
  return status === 'incompatible' || status === 'private' || status === 'unavailable';
}

/**
 * Check if a single resource should be filtered out from submission.
 * Uses server-computed canGenerate flag which is the definitive "can use" check.
 */
export function shouldFilterResource(resource: GenerationResource | undefined): boolean {
  if (!resource) return true;
  return resource.canGenerate === false;
}

/**
 * Determine if a link to the model page should be shown for this resource.
 * Show link if resource is publicly accessible OR user owns it.
 */
export function shouldShowModelLink(resource: GenerationResource): boolean {
  return resource.isOwnedByUser === true || resource.isPrivate !== true;
}

export interface FilterSnapshotOptions {
  /** Keys of computed nodes to filter out (derived values, not input) */
  computedKeys?: string[];
}

/**
 * Filter a graph snapshot before submission or whatIf query.
 * - Removes computed nodes (derived values)
 * - Removes resources where canGenerate is false (user can't use them)
 *
 * @param snapshot - The graph snapshot data
 * @param options - Filter options
 * @returns A new snapshot with computed nodes and unusable resources filtered out
 */
export function filterSnapshotForSubmit<T extends Record<string, unknown>>(
  snapshot: T,
  options: FilterSnapshotOptions = {}
): T {
  const { computedKeys = [] } = options;

  // Filter out computed nodes
  const filtered = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !computedKeys.includes(key))
  ) as Record<string, unknown>;

  // Filter out disabled resources from the resources array
  if (filtered.resources && Array.isArray(filtered.resources)) {
    filtered.resources = (filtered.resources as GenerationResource[]).filter(
      (resource) => !shouldFilterResource(resource)
    );
  }

  // Clear VAE if it's disabled
  if (filtered.vae && shouldFilterResource(filtered.vae as GenerationResource)) {
    filtered.vae = undefined;
  }

  return filtered as T;
}

// =============================================================================
// Component
// =============================================================================

export function ResourceItemContent({
  resource,
  strengthValue,
  onStrengthChange,
  disabled,
  options,
  actions,
  showStrength = true,
}: ResourceItemContentProps) {
  const { domain } = useAppContext();
  const status = getResourceStatus(resource, options);
  const isPartiallyCompatible = status === 'partial';
  const isIncompatible = status === 'incompatible';
  const isPrivate = status === 'private';
  const isUnavailable = status === 'unavailable';
  const isDisabled = isResourceDisabled(status);
  const isSfwOnly = !domain.green && (resource.model.sfwOnly || resource.model.minor);
  const epochDetails = resource.epochDetails;

  // Don't show strength slider for disabled resources
  const hasStrength =
    showStrength &&
    !isDisabled &&
    ['LORA', 'LoCon', 'DoRA'].includes(resource.model.type) &&
    onStrengthChange;
  const isSameMinMaxStrength = resource.minStrength === resource.maxStrength;

  const modelUrl = `/models/${resource.model.id}?modelVersionId=${resource.id}`;
  const showLink = shouldShowModelLink(resource);

  return (
    <>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Group gap={4} wrap="nowrap" className="min-w-0 flex-1">
          {/* Hide link for private/unpublished resources not owned by the current user */}
          {showLink ? (
            <Anchor
              href={modelUrl}
              target="_blank"
              size="sm"
              lineClamp={1}
              fw={590}
              className="truncate"
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
            >
              {resource.model.name}
            </Anchor>
          ) : (
            <Text size="sm" fw={590} lineClamp={1} className="truncate">
              {resource.model.name}
            </Text>
          )}
          {resource.name &&
            resource.model.name.toLowerCase() !== resource.name.toLowerCase() && (
              <Text size="xs" c="dimmed" className="shrink-0">
                ({resource.name})
              </Text>
            )}
          {epochDetails?.epochNumber && (
            <Badge size="sm" color="dark.5" variant="filled" className="shrink-0">
              Epoch {epochDetails.epochNumber}
            </Badge>
          )}
          {isSfwOnly && (
            <HoverCard position="bottom" withArrow width={200}>
              <HoverCard.Target>
                <ThemeIcon size={18} color="green.5" variant="filled" className="shrink-0">
                  <IconShield size={14} />
                </ThemeIcon>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Text size="sm">This resource cannot be used to generate mature content</Text>
              </HoverCard.Dropdown>
            </HoverCard>
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
          {isPrivate && (
            <HoverCard position="bottom" withArrow width={200}>
              <HoverCard.Target>
                <ThemeIcon size={18} color="red" variant="filled" className="shrink-0">
                  <IconLock size={14} />
                </ThemeIcon>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Text size="sm">
                  This resource is private. You cannot use it for generation.
                </Text>
              </HoverCard.Dropdown>
            </HoverCard>
          )}
          {isUnavailable && (
            <HoverCard position="bottom" withArrow width={200}>
              <HoverCard.Target>
                <ThemeIcon size={18} color="red" variant="filled" className="shrink-0">
                  <IconBan size={14} />
                </ThemeIcon>
              </HoverCard.Target>
              <HoverCard.Dropdown>
                <Text size="sm">
                  This resource is not available for generation.
                </Text>
              </HoverCard.Dropdown>
            </HoverCard>
          )}
        </Group>
        {actions && <Group gap={4} className="shrink-0">{actions}</Group>}
      </Group>
      {hasStrength && (
        <div className="mt-2 flex w-full items-center gap-2">
          <NumberSlider
            className="flex-1"
            value={strengthValue ?? resource.strength ?? 1}
            onChange={(strength) => onStrengthChange(strength ?? 1)}
            min={!isSameMinMaxStrength ? resource.minStrength : -1}
            max={!isSameMinMaxStrength ? resource.maxStrength : 2}
            step={0.05}
            reverse
            disabled={disabled}
          />
        </div>
      )}
    </>
  );
}
