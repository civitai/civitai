/**
 * ResourceAlerts
 *
 * Displays alerts related to selected resources including:
 * - Unstable resources (high failure rate)
 * - Content restricted resources (minor/SFW flagged)
 * - Ready state alerts (resources need to be downloaded)
 *
 * Experimental state is not here — it lives in `Experimental.tsx`, marked by a
 * flask at each level a rule can target and warned about above the submit row.
 */

import { Alert, List, Text } from '@mantine/core';

import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useAppContext } from '~/providers/AppProvider';
import { isWorkflowOrVariant } from '~/shared/data-graph/generation/config/workflows';
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
  const { unstableResources: allUnstableResources } = useGenerationConfig();
  const { domain } = useAppContext();

  // Extract resource-related values (may be undefined depending on active discriminator branch)
  const selectedResources = getSelectedResources(model, resources, vae);

  // Filter to get unstable resources from selected
  const unstableResources = selectedResources.filter((x) =>
    allUnstableResources.some((r) => r === x.id)
  );

  // On green nothing mature can be generated regardless of resource, so the alert says nothing.
  const restrictedResources = domain.green
    ? []
    : selectedResources.filter((x) => x.model?.minor || x.model?.sfwOnly);

  // Early return if no alerts
  if (unstableResources.length === 0 && restrictedResources.length === 0) {
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
      {restrictedResources.length > 0 && (
        <Alert color="yellow" title="Content Restricted" radius="md">
          <Text size="xs">
            {restrictedResources.length > 1
              ? `The following resources cannot be used to generate mature content. If you attempt to generate mature content with them,`
              : `The following resource cannot be used to generate mature content. If you attempt to generate mature content with it,`}{' '}
            the image will not be returned, but you{' '}
            <Text span italic inherit>
              will
            </Text>
            {` be charged Buzz.`}
          </Text>
          <List size="xs" mt="xs">
            {restrictedResources.map((resource) => (
              <List.Item key={resource.id}>
                {resource.model.name} - {resource.name}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
    </div>
  );
}

// =============================================================================
// Grok Ecosystem Alert
// =============================================================================

interface GrokEcosystemAlertProps {
  ecosystem?: string;
}

/**
 * Displays a warning when the Grok ecosystem is selected, informing users
 * that violations of xAI terms will still be charged.
 */
export function GrokEcosystemAlert({ ecosystem }: GrokEcosystemAlertProps) {
  if (ecosystem !== 'Grok') return null;

  return (
    <Alert color="yellow" radius="md">
      <Text size="xs">
        When the request is deemed to be in violation of xAI terms the generation of the request
        will still be charged.
      </Text>
    </Alert>
  );
}

// =============================================================================
// Seedance Img2Vid Alert
// =============================================================================

interface SeedanceImg2VidAlertProps {
  ecosystem?: string;
  workflow?: string;
}

/**
 * Warns users that Seedance's img2vid workflows are frequently rejected by the
 * provider's copyright detection (false positives).
 */
export function SeedanceImg2VidAlert({ ecosystem, workflow }: SeedanceImg2VidAlertProps) {
  if (ecosystem !== 'Seedance' || !workflow || !isWorkflowOrVariant(workflow, 'img2vid')) {
    return null;
  }

  return (
    <Alert color="yellow" title="Heads up: Seedance often rejects image-to-video" radius="md">
      <Text size="xs">
        Seedance applies strict copyright filtering to image-to-video requests and frequently flags
        ordinary images as copyrighted content, causing generations to fail. If your request is
        rejected, you will be refunded.
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
  const { data, isLoading } = useWhatIfContext();

  if (data?.ready !== false || isLoading) {
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
