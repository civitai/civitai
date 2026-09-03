import { useCallback, useEffect, useMemo, useRef } from 'react';
import { persistedStorage } from 'form-graph';
import { Controller, FormProvider, useField, useForm } from 'form-graph/react';

import {
  useGenerationConfig,
  useGenerationStatus,
} from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ButtonGroupInput } from '~/libs/form/components/ButtonGroupInput';
import { VID_QUANTITY_BY_TIER } from '~/shared/constants/generation.constants';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { getWorkflowModes } from '~/shared/data-graph/generation/config';
import {
  workflowConfigByKey,
  shouldShowBackButton,
  shouldReturnAfterSubmit,
} from '~/shared/data-graph/generation/config/workflows';
import { useWorkflowHistoryStore } from '~/store/workflow-history.store';
import { workflowPreferences } from '~/store/workflow-preferences.store';
import { generationGraphPanel } from '~/store/generation-graph.store';

import { GenerationLayout, GenerationFooter } from '~/components/generation_v2/GenerationLayout';
import { PresetControl } from '~/components/generation_v2/preset/PresetControl';
import { BaseModelInput } from '~/components/generation_v2/inputs/BaseModelInput';
import {
  WorkflowInput,
  SelectedWorkflowDisplay,
} from '~/components/generation_v2/inputs/WorkflowInput';
import { MetadataExtractionPanel } from '~/components/generation_v2/inputs/MetadataExtractionPanel';
import { MetadataExtractionFooter } from '~/components/generation_v2/FormFooter';
import { PromptEnhancePanel } from '~/components/Generation/PromptEnhance/PromptEnhancePanel';
import { usePromptEnhanceStore } from '~/components/Generation/PromptEnhance/promptEnhanceStore';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';

import { ImageGenerationForm } from './ImageGenerationForm';
import { VideoGenerationForm } from './VideoGenerationForm';
import { AudioGenerationForm } from './AudioGenerationForm';
import { Model3dGenerationForm } from './Model3dGenerationForm';
import { FormFooter } from './FormFooter';
import { WhatIfProvider } from './WhatIfProvider';
import { migrateV1GenerationStorage } from './migrate-v1-storage';
import { useOutputType, type GenerationStore } from './store';

/**
 * The BASE generation form: the entry component. Owns the store over the
 * composed root (`generationHub`) and mirrors GenerationFormV2's shell —
 * GenerationLayout chrome, preset strip, the workflow+ecosystem selector row,
 * SelectedWorkflowDisplay with back-nav and workflow modes, the img2meta /
 * prompt:enhance self-contained panels, and the footer slot. The per-output
 * bodies below all receive the SAME store — the graph is one form; only the
 * rendering splits.
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

  const storage = useMemo(() => {
    migrateV1GenerationStorage(STORAGE_KEY);
    return persistedStorage(STORAGE_KEY);
  }, []);
  useEffect(() => () => storage?.dispose(), [storage]);

  const store = useForm(generationHub, { ext, storage }) as GenerationStore;

  return (
    <FormProvider store={store}>
      <WhatIfProvider store={store} ext={ext}>
        <GenerationFormBody store={store} isMember={ext.user?.isMember ?? false} />
      </WhatIfProvider>
    </FormProvider>
  );
}

function GenerationFormBody({ store, isMember }: { store: GenerationStore; isMember: boolean }) {
  const output = useOutputType(store);
  const workflow = useField<string>(store, 'workflow')?.value;
  const ecosystem = useField<string>(store, 'ecosystem')?.value;
  const ecosystemId = ecosystem ? ecosystemByKey.get(ecosystem)?.id : undefined;

  // Track workflow/ecosystem history for enhancement-workflow back-nav —
  // same store v1 pushes to, skipping the entries created by Back itself.
  const workflowHistory = useWorkflowHistoryStore();
  const isNavigatingRef = useRef(false);
  useEffect(() => {
    if (!workflow || isNavigatingRef.current) return;
    useWorkflowHistoryStore.getState().push({ workflow, ecosystem: ecosystem ?? '' });
  }, [workflow, ecosystem]);

  const handleNavigationBack = useCallback(() => {
    const prev = workflowHistory.back() ?? workflowPreferences.getLastUsedWorkflow();
    if (!prev) return;
    isNavigatingRef.current = true;
    store.set({ workflow: prev.workflow, ecosystem: prev.ecosystem });
    generationGraphPanel.restorePreviousView();
    requestAnimationFrame(() => {
      isNavigatingRef.current = false;
    });
  }, [store, workflowHistory]);

  return (
    <GenerationLayout>
      <PresetControl />
      {/* Workflow and ecosystem selectors — always visible, single row */}
      <div className="flex w-full min-w-0 items-center gap-2 overflow-hidden sm:gap-4">
        <Controller
          graph={generationHub}
          name="workflow"
          render={({ value, onChange }) => (
            <WorkflowInput
              value={value}
              ecosystemId={ecosystemId}
              onChange={(graphKey) => onChange(graphKey)}
              isMember={isMember}
            />
          )}
        />
        <Controller
          graph={generationHub}
          name="ecosystem"
          render={({ value, meta, onChange }) => (
            <BaseModelInput
              value={value}
              onChange={onChange}
              compatibleEcosystems={meta?.compatibleEcosystems}
              excludeEcosystems={meta?.hiddenEcosystems}
              ecosystemStates={meta?.ecosystemStates}
              outputType={meta?.mediaType}
            />
          )}
        />
      </div>

      {/* img2meta: self-contained panel, no graph controllers */}
      {workflow === 'img2meta' && (
        <>
          <SelectedWorkflowDisplay workflowId="img2meta" onBack={handleNavigationBack} />
          <MetadataExtractionPanel />
          <GenerationFooter>
            <MetadataExtractionFooter />
          </GenerationFooter>
        </>
      )}

      {/* prompt:enhance: self-contained panel, reads captured data from store */}
      {workflow === 'prompt:enhance' && (
        <>
          <SelectedWorkflowDisplay workflowId="prompt:enhance" onBack={handleNavigationBack} />
          <PromptEnhancePanelWrapper store={store} onBack={handleNavigationBack} />
        </>
      )}

      {workflow !== 'img2meta' && workflow !== 'prompt:enhance' && (
        <>
          <Controller
            graph={generationHub}
            name="workflow"
            render={({ value, onChange }) => {
              const modes = ecosystem
                ? getWorkflowModes(
                    value,
                    ecosystem,
                    (store.getSnapshot().state as { model?: { id?: number } }).model?.id
                  )
                : [];
              return (
                <div className="flex flex-col gap-1">
                  <SelectedWorkflowDisplay
                    workflowId={value}
                    ecosystemId={ecosystemId}
                    onBack={shouldShowBackButton(value) ? handleNavigationBack : undefined}
                  />
                  {modes.length > 0 && (
                    <ButtonGroupInput
                      value={workflowConfigByKey.get(value)?.variantOf ?? value}
                      onChange={(v) => onChange(v)}
                      data={modes}
                    />
                  )}
                </div>
              );
            }}
          />
          {output === 'image' ? (
            <ImageGenerationForm store={store} />
          ) : output === 'video' ? (
            <VideoGenerationForm store={store} />
          ) : output === 'audio' ? (
            <AudioGenerationForm />
          ) : (
            <Model3dGenerationForm store={store} />
          )}
          <GenerationFooter>
            <FormFooter
              store={store}
              onSubmitSuccess={
                workflow && shouldReturnAfterSubmit(workflow) ? handleNavigationBack : undefined
              }
            />
          </GenerationFooter>
        </>
      )}
    </GenerationLayout>
  );
}

function PromptEnhancePanelWrapper({
  store,
  onBack,
}: {
  store: GenerationStore;
  onBack: () => void;
}) {
  const data = usePromptEnhanceStore((state) => state.data);

  // If store data is gone (e.g., page reload), navigate back to the previous workflow
  useEffect(() => {
    if (!data) onBack();
  }, [data, onBack]);

  if (!data) return null;

  return (
    <PromptEnhancePanel
      prompt={data.prompt}
      negativePrompt={data.negativePrompt}
      ecosystem={data.ecosystem}
      triggerWords={data.triggerWords}
      snippetTargets={data.snippetTargets}
      images={data.images}
      onBack={onBack}
      onApply={(enhancedPrompt, enhancedNegativePrompt) => {
        store.set({ prompt: enhancedPrompt });
        if (enhancedNegativePrompt) store.set({ negativePrompt: enhancedNegativePrompt });
        onBack();
      }}
    />
  );
}
