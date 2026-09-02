import { Paper, Stack, Text } from '@mantine/core';
import { useEffect, useMemo } from 'react';
import { persistedStorage } from 'form-graph';
import { FormProvider, useForm } from 'form-graph/react';

import {
  useGenerationConfig,
  useGenerationStatus,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { VID_QUANTITY_BY_TIER } from '~/shared/constants/generation.constants';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

import { Controller } from 'form-graph/react';
import { WorkflowInput } from '~/components/generation_v2/inputs/WorkflowInput';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { ImageGenerationForm } from './ImageGenerationForm';
import { VideoGenerationForm } from './VideoGenerationForm';
import { SubmitFooter } from './form-helpers';
import { useOutputType, type GenerationStore } from './store';

/**
 * The BASE generation form: the entry component. Owns the store over the composed root
 * (`generationHub`) and switches to the per-output-type form the way the
 * graph itself dispatches: on the `output` computed. Image and Video forms
 * receive the SAME store — the graph is one form; only the rendering splits.
 *
 * Persistence: one localStorage record of scoped intent addresses
 * (`steps@SDXL`, `ecosystem@image`, …) — the scopes themselves live on the
 * graphs (`familyScope`/`workflowScoped`/field `scope`), so this component
 * only attaches the adapter. Debounced writes; flushed on pagehide.
 */

const STORAGE_KEY = 'form-graph:generation';

export function BaseGenerationForm() {
  const status = useGenerationStatus();
  const currentUser = useCurrentUser();
  const featureFlags = useFeatureFlags();
  const { selfHostedDisabledEcosystems, selfHostedMode, gateRules } = useGenerationConfig();

  const isModerator = !!currentUser?.isModerator;

  const ext = useMemo<GenerationCtx>(
    () => ({
      limits: {
        maxQuantity: status.limits.quantity,
        maxResources: status.limits.resources,
        vidQuantity: VID_QUANTITY_BY_TIER[status.tier] ?? 1,
      },
      user: {
        isMember: status.tier !== 'free' || isModerator,
        tier: status.tier,
      },
      flags: featureFlags,
      selfHostedDisabledEcosystems,
      selfHostedMode,
      gateRules,
    }),
    [
      status.limits.quantity,
      status.limits.resources,
      status.tier,
      isModerator,
      featureFlags,
      selfHostedDisabledEcosystems,
      selfHostedMode,
      gateRules,
    ]
  );

  const storage = useMemo(() => persistedStorage(STORAGE_KEY), []);
  useEffect(() => () => storage?.dispose(), [storage]);

  const store = useForm(generationHub, { ext, storage }) as GenerationStore;
  const output = useOutputType(store);

  const isMember = ext.user?.isMember ?? false;

  return (
    <FormProvider store={store}>
      <Stack gap="md">
        <Controller
          graph={generationHub}
          name="workflow"
          render={({ value, onChange }) => {
            const snap = store.getSnapshot().state as { ecosystem?: string };
            const ecosystemId = snap.ecosystem ? ecosystemByKey.get(snap.ecosystem)?.id : undefined;
            return (
              <WorkflowInput
                value={value}
                ecosystemId={ecosystemId}
                onChange={(graphKey) => onChange(graphKey)}
                isMember={isMember}
              />
            );
          }}
        />
        {output === 'image' ? (
          <ImageGenerationForm store={store} />
        ) : output === 'video' ? (
          <VideoGenerationForm store={store} />
        ) : (
          <Paper p="md" withBorder>
            <Text size="sm" c="dimmed">
              The {output} form arrives with its families.
            </Text>
          </Paper>
        )}
        <SubmitFooter store={store} />
      </Stack>
    </FormProvider>
  );
}
