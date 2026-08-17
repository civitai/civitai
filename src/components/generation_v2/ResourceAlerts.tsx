/**
 * ResourceAlerts
 *
 * Displays alerts related to selected resources including:
 * - Unstable resources (high failure rate)
 * - Content restricted resources (minor/SFW flagged)
 * - Experimental alerts (ecosystem config + `experimental` gate rules)
 * - Ready state alerts (resources need to be downloaded)
 */

import { Alert, List, Text } from '@mantine/core';

import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { ecosystemByKey, isEcosystemExperimental } from '~/shared/constants/basemodel.constants';
import { isWorkflowOrVariant } from '~/shared/data-graph/generation/config/workflows';
import { experimentalTargets } from '~/shared/data-graph/generation/gates';
import { useWhatIfContext } from './WhatIfProvider';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';

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

/**
 * IDs of every selected resource. Separate from `getSelectedResources` because
 * the graph's resource value is minimal (`{ id, model: { type } }`) — `name`
 * arrives only via server enrichment, so a name-shaped guard misses any
 * resource the graph set itself, such as an ecosystem's default checkpoint.
 */
function getSelectedResourceIds(model: unknown, resources: unknown, vae: unknown): number[] {
  const hasId = (value: unknown): value is { id: number } =>
    value !== null &&
    typeof value === 'object' &&
    'id' in value &&
    typeof (value as { id: unknown }).id === 'number';

  const candidates = [model, ...(Array.isArray(resources) ? resources : []), vae];
  return candidates.filter(hasId).map((r) => r.id);
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
  /** The selected workflow key (e.g., 'txt2img', 'img2vid') */
  workflow?: string;
  /** The selected checkpoint / additional resources / VAE */
  model?: unknown;
  resources?: unknown;
  vae?: unknown;
}

/**
 * Displays an alert when the current selection is flagged experimental.
 *
 * Sources unioned: the static `isEcosystemExperimental` check (derived from
 * base-model `experimental` flags), and any gate rule with
 * `presentation: 'experimental'` — which can target the ecosystem, the
 * workflow, or a specific model version, and whose optional message replaces
 * the default copy.
 */
export function ExperimentalModelAlert({
  ecosystem,
  workflow,
  model,
  resources,
  vae,
}: ExperimentalModelAlertProps) {
  const { gateRules = [] } = useGenerationConfig();
  const targets = experimentalTargets(gateRules);

  const staticEcosystem = !!ecosystem && isEcosystemExperimental(ecosystem);

  // Every rule match, so the dismiss key changes when a different thing is what's
  // experimental — dismissing the Flux warning shouldn't pre-dismiss the next one.
  const matches: { key: string; message?: string }[] = [];
  if (ecosystem && targets.ecosystems.has(ecosystem))
    matches.push({ key: `eco:${ecosystem}`, message: targets.ecosystems.get(ecosystem) });
  if (workflow && targets.workflows.has(workflow))
    matches.push({ key: `wf:${workflow}`, message: targets.workflows.get(workflow) });
  for (const id of getSelectedResourceIds(model, resources, vae))
    if (targets.modelVersionIds.has(id))
      matches.push({ key: `mv:${id}`, message: targets.modelVersionIds.get(id) });

  if (!staticEcosystem && !matches.length) return null;

  const displayName = ecosystem
    ? ecosystemByKey.get(ecosystem)?.displayName ?? ecosystem
    : undefined;
  const dismissId = [...(staticEcosystem ? [`eco:${ecosystem}`] : []), ...matches.map((m) => m.key)]
    .filter((key, i, all) => all.indexOf(key) === i)
    .join('|');
  const message = matches.find((m) => m.message)?.message;
  const subject =
    staticEcosystem || (ecosystem && targets.ecosystems.has(ecosystem))
      ? `${displayName} support`
      : 'Your current selection';

  return (
    <DismissibleAlert color="yellow" title="Experimental Build" radius="md" id={dismissId}>
      <Text size="xs">
        {message ??
          `${subject} is currently in an experimental phase. Some features may not work as expected. Please report any issues you encounter.`}
      </Text>
    </DismissibleAlert>
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
