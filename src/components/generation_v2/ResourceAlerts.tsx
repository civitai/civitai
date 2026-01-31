/**
 * ResourceAlerts
 *
 * Displays alerts related to selected resources including:
 * - Unstable resources (high failure rate)
 * - Content restricted resources (minor/SFW flagged)
 * - Experimental ecosystem alerts (based on baseModel config)
 * - Ready state alerts (resources need to be downloaded)
 */

import { Alert, List, Text } from '@mantine/core';

import { useUnstableResources } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { ecosystemByKey, isEcosystemExperimental } from '~/shared/constants/basemodel.constants';
import { useWhatIfContext } from './WhatIfProvider';

// =============================================================================
// Types
// =============================================================================

interface ResourceInfo {
  id: number;
  name: string;
  model: {
    name: string;
    minor?: boolean;
    sfwOnly?: boolean;
  };
}

interface ResourceAlertsProps {
  /** The selected checkpoint model */
  model?: unknown;
  /** Array of additional resources (LoRAs, etc.) */
  resources?: unknown;
  /** The selected VAE */
  vae?: unknown;
}

// =============================================================================
// Helper Functions
// =============================================================================

function isResourceInfo(value: unknown): value is ResourceInfo {
  return (
    value !== null &&
    typeof value === 'object' &&
    'id' in value &&
    'name' in value &&
    'model' in value &&
    typeof (value as ResourceInfo).model === 'object'
  );
}

function getSelectedResources(model: unknown, resources: unknown, vae: unknown): ResourceInfo[] {
  const result: ResourceInfo[] = [];

  if (isResourceInfo(model)) result.push(model);
  if (Array.isArray(resources)) {
    resources.forEach((r) => {
      if (isResourceInfo(r)) result.push(r);
    });
  }
  if (isResourceInfo(vae)) result.push(vae);

  return result;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Displays alerts for unstable and content-restricted resources.
 * Should be used inside a MultiController for 'model', 'resources', and 'vae'.
 */
export function ResourceAlerts({ model, resources, vae }: ResourceAlertsProps) {
  const { unstableResources: allUnstableResources } = useUnstableResources();

  // Extract resource-related values (may be undefined depending on active discriminator branch)
  const selectedResources = getSelectedResources(model, resources, vae);

  // Filter to get unstable resources from selected
  const unstableResources = selectedResources.filter((x) =>
    allUnstableResources.some((r) => r === x.id)
  );

  // Filter to get content restricted resources
  const minorFlaggedResources = selectedResources.filter((x) => x.model?.minor);
  const sfwFlaggedResources = selectedResources.filter((x) => x.model?.sfwOnly);
  const hasContentRestriction = minorFlaggedResources.length > 0 || sfwFlaggedResources.length > 0;

  // Early return if no alerts
  if (unstableResources.length === 0 && !hasContentRestriction) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Unstable Resources Alert */}
      {unstableResources.length > 0 && (
        <Alert color="yellow" title="Unstable Resources" radius="md">
          <Text size="xs">
            The following resources are experiencing a high generation failure rate, possibly due to
            temporary generator instability. This usually resolves with time and does not require
            action from you. This notice will be removed once performance stabilizes.
          </Text>
          <List size="xs" mt="xs">
            {unstableResources.map((resource) => (
              <List.Item key={resource.id}>
                {resource.model.name} - {resource.name}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}

      {/* Content Restricted Alert */}
      {hasContentRestriction && (
        <Alert color="yellow" title="Content Restricted" radius="md">
          <Text size="xs">
            {minorFlaggedResources.length > 0
              ? `A resource you selected does not allow the generation of non-PG level content. If you attempt to generate non-PG`
              : `A resource you selected does not allow the generation of content rated above PG level. If you attempt to generate sexualized`}{' '}
            content with this resource the image will not be returned, but you{' '}
            <Text span italic inherit>
              will
            </Text>
            {` be charged Buzz.`}
          </Text>
          {minorFlaggedResources.length > 0 && (
            <List size="xs" mt="xs">
              {minorFlaggedResources.map((resource) => (
                <List.Item key={resource.id}>
                  {resource.model.name} - {resource.name}
                </List.Item>
              ))}
            </List>
          )}
        </Alert>
      )}
    </div>
  );
}

// =============================================================================
// Experimental Model Alert
// =============================================================================

interface ExperimentalModelAlertProps {
  /** The ecosystem key (e.g., 'Qwen', 'SD3') */
  ecosystem?: string;
}

/**
 * Displays an alert when the selected ecosystem has experimental base models.
 * Should be used inside a Controller for 'baseModel'.
 */
export function ExperimentalModelAlert({ ecosystem }: ExperimentalModelAlertProps) {
  // Check if current ecosystem is experimental using the config
  const isExperimental = ecosystem ? isEcosystemExperimental(ecosystem) : false;

  if (!isExperimental || !ecosystem) {
    return null;
  }

  // Get ecosystem display name for the message
  const ecoRecord = ecosystemByKey.get(ecosystem);
  const displayName = ecoRecord?.displayName ?? ecosystem;

  return (
    <Alert color="yellow" title="Experimental Build" radius="md">
      <Text size="xs">
        {displayName} support is currently in an experimental phase. Some features may not work as
        expected. Please report any issues you encounter.
      </Text>
    </Alert>
  );
}

// =============================================================================
// Ready Alert
// =============================================================================

/**
 * Displays an alert when resources need to be downloaded before generation.
 * Must be used inside a WhatIfProvider.
 */
export function ReadyAlert() {
  const { data } = useWhatIfContext();

  if (data?.ready !== false) {
    return null;
  }

  return (
    <Alert color="yellow" title="Potentially slow generation" radius="md">
      <Text size="xs">
        We need to download additional resources to fulfill your request. This generation may take
        longer than usual to complete.
      </Text>
    </Alert>
  );
}
