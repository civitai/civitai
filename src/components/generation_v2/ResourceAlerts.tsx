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

import type { DownloadPreparation } from '~/shared/orchestrator/download-preparation';
import { Alert, List, Loader, Stack, Switch, Text } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
import { useRef } from 'react';

import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useAppContext } from '~/providers/AppProvider';
import { isWorkflowOrVariant } from '~/shared/data-graph/generation/config/workflows';
import { formatBytes, numberWithCommas } from '~/utils/number-helpers';
import { formatDownloadEta } from '~/components/ResourceLoad/download-eta';
import { BOOST_LANE_LABEL, DownloadLanesInfo } from '~/components/ResourceLoad/download-lanes';
import { DownloadEtaCompare } from '~/components/ResourceLoad/DownloadEtaCompare';
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

export type DownloadAlertWhatIf = {
  data: { ready?: boolean };
  isLoading: boolean;
  isSuccess: boolean;
  canEstimateCost: boolean;
  preBoost: boolean;
  setPreBoost: (on: boolean) => void;
  download?: {
    preparation: DownloadPreparation;
    boostable: boolean;
    boostFee: number | null;
    pricing: boolean;
  };
};

/** Takes the whatIf as a prop because the two generation forms each have their own provider. */
export function DownloadReadyAlert({ whatIf }: { whatIf: DownloadAlertWhatIf }) {
  const { data, download, isLoading, isSuccess, canEstimateCost, preBoost, setPreBoost } = whatIf;
  // Too tall for a phone. Mobile gets the same offer as a confirm on Generate instead
  // (`resolveBoostSubmitFields`).
  const isMobile = useIsMobile({ type: 'media' });

  // Rendering from the last settled response keeps the alert on screen while a changed form re-prices.
  const settledRef = useRef<{ ready?: boolean; download: typeof download } | null>(null);
  if (isSuccess && !isLoading) settledRef.current = { ready: data.ready, download };
  const settled = settledRef.current;

  if (!canEstimateCost || !settled || (settled.ready !== false && !settled.download)) {
    return null;
  }

  // Mobile trades the full alert for the confirm on Generate, but that only opens when there is a
  // boost to sell — so the wait itself still has to be said somewhere.
  if (isMobile) {
    const preparation = settled.download?.preparation;
    if (!preparation) return null;
    const size = preparation.resources.reduce((sum, r) => sum + r.sizeBytes, 0);
    return (
      <Alert color="blue" radius="md" p="xs">
        <Text size="xs">
          {preparation.resources.length === 1 ? 'A resource needs' : 'Resources need'} to be loaded
          first{size > 0 ? ` — ${formatBytes(size)}` : ''}
          {preparation.etaSeconds != null
            ? `. Ready in ${formatDownloadEta(preparation.etaSeconds)}.`
            : '.'}
        </Text>
      </Alert>
    );
  }

  if (!settled.download) {
    return (
      <Alert color="yellow" title="Potentially slow generation" radius="md">
        <Text size="xs">
          We need to download additional resources to fulfill your request. This generation may take
          longer than usual to complete.
        </Text>
      </Alert>
    );
  }

  const { preparation, boostable, boostFee, pricing } = settled.download;
  const { etaSeconds, boostedEtaSeconds, lane } = preparation;
  const count = preparation.resources.length;
  const resourcesLabel = count === 1 ? 'resource' : `${count} resources`;
  const totalBytes = preparation.resources.reduce((sum, r) => sum + r.sizeBytes, 0);
  const on = preBoost && boostable;

  return (
    <Alert color={on ? 'yellow' : 'blue'} radius="md" p="sm">
      <Stack gap="sm">
        {on ? (
          <Text size="sm">
            <Text span fw={600}>
              Boosted
            </Text>{' '}
            — your {resourcesLabel} go{count === 1 ? 'es' : ''} in the {BOOST_LANE_LABEL} lane
            {boostedEtaSeconds != null &&
              `, so this generation starts in ${formatDownloadEta(boostedEtaSeconds)}`}
            {etaSeconds != null && ` instead of ${formatDownloadEta(etaSeconds)}`}.
          </Text>
        ) : (
          <Text size="sm">
            <Text span fw={600}>
              {count === 1 ? 'A resource needs' : `${count} resources need`} to be loaded first
            </Text>{' '}
            — {formatBytes(totalBytes)}.
            {boostable && boostedEtaSeconds != null
              ? ` Boost to ${
                  lane === 'low' ? 'skip the free lane and ' : ''
                }start in ${formatDownloadEta(boostedEtaSeconds)}.`
              : etaSeconds != null
              ? ` Ready in ${formatDownloadEta(etaSeconds)}.`
              : ''}
          </Text>
        )}

        {boostable && etaSeconds != null && boostedEtaSeconds != null && (
          <DownloadEtaCompare
            etaSeconds={etaSeconds}
            boostedEtaSeconds={boostedEtaSeconds}
            afterLabel={on ? 'Ready in' : 'Boosted'}
            struck={on}
          />
        )}

        {boostable && (
          <div className="flex items-center gap-2 border-t border-white/10 pt-2.5">
            <Switch
              size="sm"
              color="yellow"
              checked={on}
              disabled={boostFee == null}
              onChange={(e) => setPreBoost(e.currentTarget.checked)}
              label="Boost download"
              styles={{ label: { fontWeight: 600 } }}
            />
            <DownloadLanesInfo
              placement={{
                lane,
                queuePosition: preparation.queuePosition,
                transferring: preparation.progress != null,
                etaSeconds,
                boostedEtaSeconds,
                rateLimitBytesPerSecond: preparation.rateLimitBytesPerSecond,
                totalBytes,
                boostFee,
              }}
            />
            <span className="ml-auto">
              {boostFee != null ? (
                <Text size="sm" fw={700} c="yellow.6" className="whitespace-nowrap tabular-nums">
                  <IconBolt size={13} className="inline align-[-1px]" />
                  {numberWithCommas(boostFee)}
                </Text>
              ) : pricing ? (
                <Loader size="xs" color="yellow" />
              ) : null}
            </span>
          </div>
        )}
      </Stack>
    </Alert>
  );
}

/** Must be used inside generation_v2's WhatIfProvider. */
export function ReadyAlert() {
  return <DownloadReadyAlert whatIf={useWhatIfContext()} />;
}
