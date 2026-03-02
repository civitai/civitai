/**
 * GenerationForm
 *
 * Main form component for the generation UI using the Controller pattern.
 * Handles workflow/ecosystem selection with compatibility checks.
 *
 * Zustand stores used across this file and its associated components/hooks:
 *
 * | Store                              | Definition                                  | Used By                                                          | Storage        |
 * |------------------------------------|---------------------------------------------|------------------------------------------------------------------|----------------|
 * | useGenerationGraphStore            | store/generation-graph.store.ts              | GenerationForm, GenerationFormProvider, GeneratedItemWorkflowMenu | memory (immer) |
 * | useWorkflowPreferencesStore        | store/workflow-preferences.store.ts          | GenerationFormProvider, useCompatibilityInfo, useGeneratedItemWorkflows | localStorage   |
 * | useTipStore                        | store/tip.store.ts                           | FormFooter                                                       | localStorage   |
 * | useSourceMetadataStore             | store/source-metadata.store.ts               | ImageUploadMultipleInput, FormFooter, useGeneratedItemWorkflows  | sessionStorage |
 * | useRemixStore                      | store/remix.store.ts                         | FormFooter, useRemixOfId, useGeneratedItemWorkflows              | localStorage   |
 * | useEcosystemGroupPreferencesStore  | store/ecosystem-group-preferences.store.ts   | BaseModelInput                                                   | localStorage   |
 * | useLegacyGeneratorStore            | store/legacy-generator.store.ts              | useGeneratedItemWorkflows                                        | localStorage   |
 * | usePromptFocusedStore              | inputs/PromptInput.tsx (local)               | PromptInput                                                      | memory         |
 */

import {
  Button,
  Checkbox,
  Divider,
  Group,
  Input,
  Menu,
  Paper,
  Radio,
  Stack,
  Switch,
  Tabs,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import clsx from 'clsx';
import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';

import { CopyButton } from '~/components/CopyButton/CopyButton';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { Controller, MultiController, useGraph } from '~/libs/data-graph/react';
import {
  type GenerationGraphTypes,
  type VersionOption,
  type VersionGroup,
  type VideoValue,
  getAllVersionIds,
  wanVersionOptions,
  wanVersionDefs,
} from '~/shared/data-graph/generation';
import { getWorkflowModes } from '~/shared/data-graph/generation/config';
import {
  getOutputTypeForWorkflow,
  isEnhancementWorkflow,
} from '~/shared/data-graph/generation/config/workflows';
import { ecosystemById } from '~/shared/constants/basemodel.constants';

import { useWorkflowHistoryStore } from '~/store/workflow-history.store';
import { workflowPreferences } from '~/store/workflow-preferences.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useCompatibilityInfo } from './hooks/useCompatibilityInfo';
import { AccordionLayout } from './AccordionLayout';
import { openCompatibilityConfirmModal } from './CompatibilityConfirmModal';
import { FormFooter } from './FormFooter';
import { ResourceAlerts, ExperimentalModelAlert, ReadyAlert } from './ResourceAlerts';

// Input components
import { BaseModelInput } from './inputs/BaseModelInput';
import { WorkflowInput, SelectedWorkflowDisplay } from './inputs/WorkflowInput';
import { ResourceSelectInput } from './inputs/ResourceSelectInput';
import { useResourceDataContext } from './inputs/ResourceDataProvider';
import { ResourceSelectMultipleInput } from './inputs/ResourceSelectMultipleInput';
import { PromptInput } from './inputs/PromptInput';
import { AspectRatioInput } from './inputs/AspectRatioInput';
import { SliderInput } from './inputs/SliderInput';
import { SelectInput } from './inputs/SelectInput';
import { SeedInput } from './inputs/SeedInput';
import { ImageUploadMultipleInput } from './inputs/ImageUploadMultipleInput';
import { VideoInput } from './inputs/VideoInput';
import { InterpolationFactorInput } from './inputs/InterpolationFactorInput';
import { PriorityInput } from './inputs/PriorityInput';
import { OutputFormatInput } from './inputs/OutputFormatInput';
import { ScaleFactorInput } from './inputs/ScaleFactorInput';
import { UpscaleDimensionsInput } from './inputs/UpscaleDimensionsInput';
import { SegmentedControlWrapper } from '~/libs/form/components/SegmentedControlWrapper';
import { ButtonGroupInput } from '~/libs/form/components/ButtonGroupInput';
import { KlingElementsInput } from './inputs/KlingElementsInput';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';

// =============================================================================
// Component
// =============================================================================

export function GenerationForm() {
  const graph = useGraph<GenerationGraphTypes>();
  const workflowHistory = useWorkflowHistoryStore();
  const currentUser = useCurrentUser();
  const isMember = !!currentUser && currentUser.tier !== 'free';
  // Access graph snapshot directly for workflow/ecosystem (they exist in discriminated branches)
  const snapshot = graph.getSnapshot() as { workflow?: string; ecosystem?: string };
  // Force re-render when workflow or ecosystem changes
  // Use loose typing for subscribe since ecosystem is in a discriminated branch
  const [, forceUpdate] = useState({});
  useEffect(() => {
    const unsubWorkflow = graph.subscribe('workflow', () => forceUpdate({}));
    type LooseGraph = { subscribe: (key: string, cb: () => void) => () => void };
    const unsubEcosystem = (graph as LooseGraph).subscribe('ecosystem', () => forceUpdate({}));
    return () => {
      unsubWorkflow();
      unsubEcosystem();
    };
  }, [graph]);

  // Get compatibility info based on current workflow and ecosystem
  const compatibility = useCompatibilityInfo({
    workflow: snapshot.workflow,
    ecosystem: snapshot.ecosystem,
  });

  // Use ref to store the graph instance for callbacks (avoids stale closure)
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Push workflow/ecosystem changes to navigation history on every render where they change.
  // Uses getState() to avoid adding workflowHistory as a dependency.
  const isNavigatingRef = useRef(false);
  useEffect(() => {
    if (snapshot.workflow && !isNavigatingRef.current) {
      useWorkflowHistoryStore
        .getState()
        .push({ workflow: snapshot.workflow, ecosystem: snapshot.ecosystem ?? '' });
    }
  }, [snapshot.workflow, snapshot.ecosystem]);

  // Navigate back in workflow history (falls back to last-used non-enhancement workflow)
  // Also restores the panel view the user was on before opening the enhancement form
  const handleNavigationBack = useCallback(() => {
    const prev = workflowHistory.back() ?? workflowPreferences.getLastUsedWorkflow();
    if (!prev) return;
    isNavigatingRef.current = true;
    graph.set({
      workflow: prev.workflow,
      ecosystem: prev.ecosystem,
    } as Parameters<typeof graph.set>[0]);
    // Restore the panel view the user was on before (e.g., queue/feed)
    generationGraphPanel.restorePreviousView();
    // Reset on next render (after snapshot has updated and the push effect has run)
    requestAnimationFrame(() => {
      isNavigatingRef.current = false;
    });
  }, [graph, workflowHistory]);

  // Handle workflow selection with compatibility check
  // Receives (graphKey, ecosystemIds, optionId) from WorkflowInput — ecosystemIds are per-entry (not aggregated)
  const handleWorkflowChange = useCallback(
    (graphKey: string, ecosystemIds: number[], optionId: string) => {
      // Check if the selected entry is compatible with the current ecosystem
      // Cross-output-type changes (image ↔ video) are always compatible — the graph resolves the ecosystem
      const changesOutputType =
        compatibility.currentOutputType !== undefined &&
        getOutputTypeForWorkflow(graphKey) !== compatibility.currentOutputType;
      const isEntryCompatible =
        changesOutputType ||
        ecosystemIds.length === 0 ||
        (compatibility.currentEcosystemId !== undefined &&
          ecosystemIds.includes(compatibility.currentEcosystemId));

      if (!isEntryCompatible) {
        // Get recommended ecosystem (considers last-used preferences)
        const recommended = compatibility.getTargetEcosystemForWorkflow(graphKey);
        const defaultKey = recommended?.key;

        if (ecosystemIds.length > 0 && compatibility.currentEcosystemKey) {
          openCompatibilityConfirmModal({
            pendingChange: {
              type: 'workflow',
              value: graphKey,
              optionId,
              currentEcosystem: compatibility.currentEcosystemKey,
              compatibleEcosystemIds: ecosystemIds,
              defaultEcosystemKey: defaultKey ?? ecosystemById.get(ecosystemIds[0]!)?.key ?? '',
            },
            onConfirm: (selectedEcosystemKey) => {
              if (selectedEcosystemKey) {
                graphRef.current.set({
                  workflow: graphKey,
                  ecosystem: selectedEcosystemKey,
                } as Parameters<typeof graph.set>[0]);
              }
            },
          });
          return;
        }
      }
      graph.set({ workflow: graphKey } as Parameters<typeof graph.set>[0]);
    },
    [compatibility, graph]
  );

  // Handle ecosystem selection with compatibility check
  const handleBaseModelChange = useCallback(
    (newBaseModel: string, ecosystemLabel: string) => {
      if (!compatibility.isEcosystemKeyCompatible(newBaseModel)) {
        const target = compatibility.getTargetWorkflowForEcosystem(newBaseModel);

        // Cross-output-type changes (video → image or image → video) are intentional
        // mode switches — apply directly without a confirmation modal
        const targetOutputType = getOutputTypeForWorkflow(target.id);
        if (
          compatibility.currentOutputType &&
          targetOutputType !== compatibility.currentOutputType
        ) {
          graphRef.current.set({
            workflow: target.id,
            ecosystem: newBaseModel,
          } as Parameters<typeof graph.set>[0]);
          return;
        }

        openCompatibilityConfirmModal({
          pendingChange: {
            type: 'ecosystem',
            value: newBaseModel,
            ecosystemLabel,
            currentWorkflowId: snapshot.workflow ?? 'txt2img',
            targetWorkflowId: target.id,
          },
          onConfirm: () => {
            // Set both workflow and ecosystem together to avoid validation issues
            graphRef.current.set({
              workflow: target.id,
              ecosystem: newBaseModel,
            } as Parameters<typeof graph.set>[0]);
          },
        });
        return;
      }
      graph.set({ ecosystem: newBaseModel } as Parameters<typeof graph.set>[0]);
    },
    [compatibility, graph, snapshot.workflow]
  );

  return (
    <div className="flex size-full flex-1 flex-col">
      <div className="flex-1 p-2">
        <Stack gap="sm" className="w-full">
          {/* Workflow and ecosystem selectors - inline */}
          <Group gap="xs" wrap="nowrap" className="w-full justify-between">
            <Controller
              graph={graph}
              name="workflow"
              render={({ value }) => (
                <WorkflowInput
                  value={value}
                  ecosystemId={compatibility.currentEcosystemId}
                  onChange={handleWorkflowChange}
                  isCompatible={compatibility.isWorkflowCompatible}
                  isMember={isMember}
                />
              )}
            />

            <Controller
              graph={graph}
              name="ecosystem"
              render={({ value, meta }) => (
                <BaseModelInput
                  value={value}
                  onChange={(newValue) => {
                    // Get ecosystem label for the modal
                    const label = newValue; // Will be resolved in the component
                    handleBaseModelChange(newValue, label);
                  }}
                  compatibleEcosystems={meta?.compatibleEcosystems}
                  isCompatible={compatibility.isEcosystemKeyCompatible}
                  getTargetWorkflow={(key) =>
                    compatibility.getTargetWorkflowForEcosystem(key).label
                  }
                  outputType={compatibility.currentOutputType}
                />
              )}
            />
          </Group>

          {/* Selected workflow display OR mode selector */}
          <Controller
            graph={graph}
            name="workflow"
            render={({ value }) => {
              const modes = snapshot.ecosystem
                ? getWorkflowModes(value as string, snapshot.ecosystem)
                : [];

              return (
                <div className="flex flex-col gap-1">
                  <SelectedWorkflowDisplay
                    workflowId={value as string}
                    ecosystemId={compatibility.currentEcosystemId}
                    onBack={
                      isEnhancementWorkflow(value as string) ? handleNavigationBack : undefined
                    }
                  />
                  {modes.length > 0 && (
                    <ButtonGroupInput
                      value={value as string}
                      onChange={(v) =>
                        graph.set({ workflow: v } as Parameters<typeof graph.set>[0])
                      }
                      data={modes}
                    />
                  )}
                </div>
              );
            }}
          />

          {/* Checkpoint/Model selector with version selector */}
          <div className="flex flex-col gap-1">
            <Controller
              graph={graph}
              name="model"
              render={({ value, meta, onChange }) => {
                return (
                  <>
                    <ResourceSelectInput
                      value={value as any}
                      onChange={onChange as any}
                      label={
                        <ControllerLabel
                          label="Model"
                          info="Models are the resources you're generating with. Using a different base model can drastically alter the style and composition of images, while adding additional resources can change the characters, concepts and objects."
                        />
                      }
                      buttonLabel="Select Model"
                      modalTitle="Select Model"
                      options={meta.options}
                      allowRemove={false}
                      allowSwap={!meta.modelLocked}
                      onRevertToDefault={
                        meta.defaultModelId
                          ? () => onChange({ id: meta.defaultModelId } as any)
                          : undefined
                      }
                    />
                    {/* Hierarchical version selectors (e.g., precision/variant for HiDream) */}
                    {meta.versions && (
                      <VersionGroupSelector
                        versions={meta.versions}
                        modelId={(value as any)?.id}
                        onChange={onChange as any}
                      />
                    )}
                  </>
                );
              }}
            />

            {/* Wan version picker */}
            <Controller
              graph={graph}
              name="wanVersion"
              render={({ value }) => (
                <ButtonGroupInput
                  value={value}
                  onChange={(v) => {
                    const def = wanVersionDefs.find((d) => d.version === v);
                    if (!def) return;
                    const snap = graph.getSnapshot() as { workflow?: string };
                    const isImg2vid = snap.workflow === 'img2vid';
                    // Set ecosystem directly — wanVersion is computed from it
                    // v2.1: always T2V, wan21Graph handles I2V (resolution-dependent)
                    const eco =
                      isImg2vid && def.version !== 'v2.1' ? def.ecosystems.i2v : def.ecosystems.t2v;
                    (graph as { set: (v: Record<string, unknown>) => void }).set({
                      ecosystem: eco,
                    });
                  }}
                  data={wanVersionOptions}
                />
              )}
            />
          </div>

          {/* API version selector (e.g., Veo 3.0 vs 3.1) */}
          <Controller
            graph={graph}
            name="version"
            render={({ value, meta, onChange }) => (
              <Radio.Group
                value={value}
                onChange={(v) => onChange(v as typeof value)}
                label="API Version"
              >
                <Group mt="xs">
                  {meta.options.map((o: { label: string; value: string }) => (
                    <Radio key={o.value} value={o.value} label={o.label} />
                  ))}
                </Group>
              </Radio.Group>
            )}
          />

          {/* Additional resources (LoRA, etc.) */}
          <Controller
            graph={graph}
            name="resources"
            render={({ value, meta, onChange }) => (
              <ResourceSelectMultipleInput
                value={value as any}
                onChange={onChange as any}
                label="Additional Resources"
                buttonLabel="Add LoRA"
                modalTitle="Select Resources"
                options={meta.options}
                limit={meta.limit}
              />
            )}
          />

          {/* Generation mode (standard/professional) */}
          <Controller
            graph={graph}
            name="mode"
            render={({ value, meta, onChange }) => (
              <Radio.Group
                value={value}
                onChange={(v) => onChange(v as typeof value)}
                label={
                  <ControllerLabel
                    label="Mode"
                    info="Standard mode is faster to generate and more cost-effective. Pro takes longer to generate and has higher quality output."
                  />
                }
              >
                <Group mt="xs">
                  {meta.options.map((o: { label: string; value: string }) => (
                    <Radio key={o.value} value={o.value} label={o.label} />
                  ))}
                </Group>
              </Radio.Group>
            )}
          />

          {/* Resource Alerts - Unstable, Content Restricted */}
          <MultiController
            graph={graph}
            names={['model', 'resources', 'vae'] as const}
            render={({ values }) => (
              <ResourceAlerts model={values.model} resources={values.resources} vae={values.vae} />
            )}
          />

          {/* Experimental Ecosystem Alert */}
          <Controller
            graph={graph}
            name="ecosystem"
            render={({ value }) => <ExperimentalModelAlert ecosystem={value} />}
          />

          {/* Ready State Alert - Resources need downloading */}
          <ReadyAlert />

          {/* Source images with optional mode selector */}
          <Controller
            graph={graph}
            name="images"
            render={({ value, meta, onChange, error }) => (
              <ImageUploadMultipleInput
                value={value}
                onChange={onChange}
                aspect="square"
                max={meta?.max}
                slots={meta?.slots}
                error={error?.message}
                enableDrawing={snapshot.workflow === 'img2img:edit'}
                warnOnMissingAiMetadata={meta?.warnOnMissingAiMetadata}
              />
            )}
          />

          {/* Kling V3: Multi-shot toggle */}
          <Controller
            graph={graph}
            name="multiShot"
            render={({ value, onChange }) => (
              <Input.Wrapper
                label="Multi-Shot"
                description="Enable multi-segment video generation with per-element media and prompts"
              >
                <Switch
                  checked={value}
                  onChange={(e) => onChange(e.currentTarget.checked)}
                  mt={4}
                />
              </Input.Wrapper>
            )}
          />

          {/* Kling V3: Multi-shot elements */}
          <Controller
            graph={graph}
            name="klingElements"
            render={({ value, onChange }) => (
              <KlingElementsInput value={value ?? []} onChange={onChange} />
            )}
          />

          {/* Source video (vid2vid only) */}
          <Controller
            graph={graph}
            name="video"
            render={({ value, onChange }) => (
              <VideoInput
                value={value}
                onChange={onChange as (v: VideoValue | undefined) => void}
              />
            )}
          />

          {/* Interpolation factor (vid2vid:interpolate only) */}
          <Controller
            graph={graph}
            name="interpolationFactor"
            render={({ value, meta, onChange }) => {
              const factor = value ?? 2;
              return (
                <InterpolationFactorInput
                  value={value}
                  onChange={onChange}
                  meta={meta}
                  targetFps={meta.sourceFps ? factor * meta.sourceFps : undefined}
                />
              );
            }}
          />

          {/* Scale factor (vid2vid:upscale) */}
          <Controller
            graph={graph}
            name="scaleFactor"
            render={({ value, meta, onChange }) => (
              <ScaleFactorInput
                value={value}
                onChange={onChange}
                width={meta.sourceWidth}
                height={meta.sourceHeight}
                maxResolution={meta.maxOutputResolution}
                options={meta.options}
              />
            )}
          />

          {/* Upscale selection (img2img:upscale) */}
          <Controller
            graph={graph}
            name="upscaleSelection"
            render={({ value, meta, onChange }) => (
              <UpscaleDimensionsInput value={value} onChange={onChange} meta={meta} />
            )}
          />

          {/* Prompt with Trigger Words */}
          <Controller
            graph={graph}
            name="prompt"
            render={({ value, onChange, meta, error }) => (
              <Input.Wrapper
                label={
                  <ControllerLabel
                    label="Prompt"
                    info="Type out what you'd like to generate in the prompt, add aspects you'd like to avoid in the negative prompt."
                  />
                }
                required={meta.required}
                error={error?.message}
              >
                <Paper
                  radius="md"
                  withBorder
                  className="bg-white focus-within:border-blue-6 dark:bg-dark-6 dark:focus-within:border-blue-8"
                >
                  <PromptInput
                    px="sm"
                    name="prompt"
                    value={value}
                    onChange={onChange}
                    onFillForm={(metadata) => {
                      const { resources, ...data } = metadata;
                      graph.set(data as Parameters<typeof graph.set>[0]);
                    }}
                    placeholder="Your prompt goes here..."
                    autosize
                    minRows={2}
                    variant="unstyled"
                    styles={(theme) => ({
                      input: {
                        padding: '10px 0',
                        backgroundColor: 'transparent',
                        lineHeight: theme.lineHeights.sm,
                      },
                      error: { display: 'none' },
                      wrapper: { margin: 0 },
                    })}
                  />
                  {/* Nested trigger words controller */}
                  <Controller
                    graph={graph}
                    name="triggerWords"
                    render={({ value }) => {
                      const triggerWords = value as string[] | undefined;
                      if (!triggerWords || triggerWords.length === 0) return null;
                      return (
                        <div className="mb-1 flex flex-col gap-2">
                          <Divider />
                          <Text c="dimmed" className="text-xs font-semibold">
                            Trigger words
                          </Text>
                          <div className="mb-2 flex items-center gap-1">
                            <TrainedWords
                              type="LORA"
                              trainedWords={triggerWords}
                              badgeProps={{
                                style: {
                                  textTransform: 'none',
                                  height: 'auto',
                                  cursor: 'pointer',
                                },
                              }}
                            />
                            <CopyButton value={triggerWords.join(', ')}>
                              {({ copied, copy, Icon, color }) => (
                                <Button
                                  variant="subtle"
                                  color={color ?? 'blue.5'}
                                  onClick={copy}
                                  size="compact-xs"
                                  classNames={{ root: 'shrink-0', inner: 'flex gap-1' }}
                                >
                                  {copied ? 'Copied' : 'Copy All'} <Icon size={14} />
                                </Button>
                              )}
                            </CopyButton>
                          </div>
                        </div>
                      );
                    }}
                  />
                </Paper>
              </Input.Wrapper>
            )}
          />

          {/* Negative prompt (SD only) */}
          <Controller
            graph={graph}
            name="negativePrompt"
            render={({ value, onChange }) => (
              <PromptInput
                value={value}
                onChange={onChange}
                label="Negative Prompt"
                placeholder="What to avoid..."
                autosize
                minRows={1}
              />
            )}
          />

          {/* Aspect ratio */}
          <Controller
            graph={graph}
            name="aspectRatio"
            render={({ value, meta, onChange }) => {
              // Get middle 5 items as priority options when there are more than 5
              const priorityOptions =
                meta.options.length > 5 ? meta.options.slice(1, 6).map((o) => o.value) : undefined;

              return (
                <AspectRatioInput
                  value={value}
                  onChange={onChange}
                  label="Aspect Ratio"
                  options={meta.options}
                  priorityOptions={priorityOptions}
                  maxVisible={5}
                />
              );
            }}
          />

          {/* Duration (video ecosystems) */}
          <Controller
            graph={graph}
            name="duration"
            render={({ value, meta, onChange }) => {
              const sliderMeta = meta as {
                min?: number;
                max?: number;
                step?: number;
                options?: { label: string; value: string | number }[];
              };
              const disabled = (meta as { disabled?: boolean })?.disabled;
              if (sliderMeta.min !== undefined && sliderMeta.max !== undefined) {
                return (
                  <SliderInput
                    label="Duration (seconds)"
                    value={value as number}
                    onChange={onChange}
                    min={sliderMeta.min}
                    max={sliderMeta.max}
                    step={sliderMeta.step ?? 1}
                    disabled={disabled}
                  />
                );
              }
              return (
                <div className="flex flex-col gap-1">
                  <Input.Label>Duration</Input.Label>
                  <SegmentedControlWrapper
                    value={value}
                    onChange={(v) => onChange(v)}
                    data={
                      sliderMeta.options?.map((o) => ({ label: o.label, value: o.value })) ?? []
                    }
                    disabled={disabled}
                  />
                </div>
              );
            }}
          />

          {/* Style (Vidu - General/Anime) */}
          <Controller
            graph={graph}
            name="style"
            render={({ value, meta, onChange }) => (
              <Radio.Group
                value={value}
                onChange={(v) => onChange(v as typeof value)}
                label="Style"
              >
                <Group mt="xs">
                  {meta.options.map((o: { label: string; value: string }) => (
                    <Radio key={o.value} value={o.value} label={o.label} />
                  ))}
                </Group>
              </Radio.Group>
            )}
          />

          {/* Resolution (Wan/Sora video quality) */}
          <Controller
            graph={graph}
            name="resolution"
            render={({ value, meta, onChange }) => (
              <div className="flex flex-col gap-1">
                <Input.Label>Resolution</Input.Label>
                <SegmentedControlWrapper
                  value={value}
                  onChange={(v) => onChange(v as typeof value)}
                  data={meta.options.map((o: { label: string; value: string }) => ({
                    label: o.label,
                    value: o.value,
                  }))}
                />
              </div>
            )}
          />

          {/* Output Settings (image output only) */}
          <Controller
            graph={graph}
            name="output"
            render={({ value: outputValue }) =>
              outputValue === 'image' ? (
                <div className="flex flex-col gap-1">
                  <Input.Label>Output Settings</Input.Label>
                  <div className="flex items-center gap-2">
                    <Controller
                      graph={graph}
                      name="outputFormat"
                      render={({ value, meta, onChange }) => (
                        <OutputFormatInput
                          value={value}
                          onChange={onChange as (v: string) => void}
                          options={meta?.options ?? []}
                          isMember={meta?.isMember}
                        />
                      )}
                    />
                    <Controller
                      graph={graph}
                      name="priority"
                      render={({ value, meta, onChange }) => (
                        <PriorityInput
                          value={value}
                          onChange={onChange}
                          options={meta?.options ?? []}
                          isMember={meta?.isMember}
                        />
                      )}
                    />
                  </div>
                </div>
              ) : null
            }
          />

          {/* Advanced section */}
          <AccordionLayout label="Advanced" storeKey="data-graph-v2-advanced">
            {/* CFG Scale / Guidance - label varies by model family */}
            <Controller
              graph={graph}
              name="cfgScale"
              render={({ value, meta, onChange }) => (
                <SliderInput
                  value={value}
                  onChange={onChange}
                  label={
                    <ControllerLabel
                      label="CFG Scale"
                      info="Controls how closely the generation follows the text prompt."
                    />
                  }
                  min={meta.min}
                  max={meta.max}
                  step={meta.step}
                  presets={meta.presets}
                />
              )}
            />

            {/* Sampler */}
            <Controller
              graph={graph}
              name="sampler"
              render={({ value, meta, onChange }) => (
                <SelectInput
                  value={value}
                  onChange={onChange}
                  label={
                    <ControllerLabel
                      label="Sampler"
                      info="Each will produce a slightly (or significantly) different result."
                    />
                  }
                  options={meta.options}
                  presets={meta.presets}
                />
              )}
            />

            {/* Scheduler (SdCpp ecosystems) */}
            <Controller
              graph={graph}
              name="scheduler"
              render={({ value, meta, onChange }) => (
                <SelectInput
                  value={value}
                  onChange={onChange}
                  label={
                    <ControllerLabel
                      label="Scheduler"
                      info="Controls the noise schedule during generation, affecting quality and style."
                    />
                  }
                  options={meta.options}
                />
              )}
            />

            {/* Steps */}
            <Controller
              graph={graph}
              name="steps"
              render={({ value, meta, onChange }) => (
                <SliderInput
                  value={value}
                  onChange={onChange}
                  label={
                    <ControllerLabel
                      label="Steps"
                      info="The number of iterations spent generating."
                    />
                  }
                  min={meta.min}
                  max={meta.max}
                  step={meta.step}
                  presets={meta.presets}
                />
              )}
            />

            {/* Movement amplitude (Vidu) */}
            <Controller
              graph={graph}
              name="movementAmplitude"
              render={({ value, meta, onChange }) => (
                <div className="flex flex-col gap-1">
                  <ControllerLabel
                    label="Movement Amplitude"
                    info="Control the scale of camera movements and subject actions. Default: Auto (fits most use cases)."
                  />
                  <SegmentedControlWrapper
                    value={value}
                    onChange={onChange}
                    data={meta.options.map((o: { label: string; value: string }) => ({
                      label: o.label,
                      value: o.value,
                    }))}
                  />
                </div>
              )}
            />

            {/* Seed */}
            <Controller
              graph={graph}
              name="seed"
              render={({ value, onChange }) => (
                <SeedInput value={value} onChange={onChange} label="Seed" />
              )}
            />

            {/* CLIP Skip (SD only) */}
            <Controller
              graph={graph}
              name="clipSkip"
              render={({ value, meta, onChange }) => (
                <SliderInput
                  value={value}
                  onChange={onChange}
                  label="CLIP Skip"
                  min={meta.min}
                  max={meta.max}
                  step={meta.step}
                  presets={meta.presets}
                />
              )}
            />

            {/* Denoise (img2img only) */}
            <Controller
              graph={graph}
              name="denoise"
              render={({ value, meta, onChange }) =>
                meta ? (
                  <SliderInput
                    value={value}
                    onChange={onChange}
                    label="Denoise Strength"
                    min={meta.min}
                    max={meta.max}
                    step={meta.step}
                  />
                ) : null
              }
            />

            {/* VAE (SD only) */}
            <Controller
              graph={graph}
              name="vae"
              render={({ value, meta, onChange }) => (
                <ResourceSelectInput
                  value={value as any}
                  onChange={onChange as any}
                  label={
                    <ControllerLabel
                      label="VAE"
                      info="These provide additional color and detail improvements."
                    />
                  }
                  buttonLabel="Select VAE"
                  modalTitle="Select VAE"
                  options={meta.options}
                  allowRemove
                />
              )}
            />

            <Controller
              graph={graph}
              name="enhancedCompatibility"
              render={({ value, onChange }) => (
                <Checkbox
                  checked={value}
                  onChange={(e) => onChange(e.target.checked)}
                  label="Enhanced Compatibility"
                />
              )}
            />

            {/* Sora Pro mode toggle */}
            <Controller
              graph={graph}
              name="usePro"
              render={({ value, onChange }) => (
                <Checkbox
                  checked={value}
                  onChange={(e) => onChange(e.target.checked)}
                  label="Pro Mode"
                  description="Generate with higher quality (uses more credits)"
                />
              )}
            />

            {/* Flux Ultra Raw mode toggle */}
            <Controller
              graph={graph}
              name="fluxUltraRaw"
              render={({ value, onChange }) => (
                <Checkbox
                  checked={value}
                  onChange={(e) => onChange(e.target.checked)}
                  label="Raw Mode"
                  description="Generate with more natural, less processed look"
                />
              )}
            />

            {/* OpenAI Transparent Background toggle */}
            <Controller
              graph={graph}
              name="transparent"
              render={({ value, onChange }) => (
                <Checkbox
                  checked={value}
                  onChange={(e) => onChange(e.target.checked)}
                  label="Transparent Background"
                  description="Generate image with transparent background"
                />
              )}
            />

            {/* OpenAI Quality selector */}
            <Controller
              graph={graph}
              name="quality"
              render={({ value, meta, onChange }) => (
                <SelectInput
                  value={value}
                  onChange={onChange as (v: string) => void}
                  label="Quality"
                  options={meta.options}
                />
              )}
            />

            {/* Prompt enhancer toggle (video ecosystems) */}
            <Controller
              graph={graph}
              name="enablePromptEnhancer"
              render={({ value, onChange }) => (
                <Checkbox
                  label="Enhance prompt"
                  description="Automatically improve your prompt for better results"
                  checked={value}
                  onChange={(e) => onChange(e.currentTarget.checked)}
                />
              )}
            />

            {/* NanoBanana V2: Web search toggle */}
            <Controller
              graph={graph}
              name="enableWebSearch"
              render={({ value, onChange }) => (
                <Switch
                  label="Web Search"
                  description="Enable web search for the image generation task. This will allow the model to use the latest information from the web to generate the image."
                  checked={value}
                  onChange={(e) => onChange(e.currentTarget.checked)}
                />
              )}
            />

            {/* Generate audio toggle (video ecosystems) */}
            <Controller
              graph={graph}
              name="generateAudio"
              render={({ value, onChange }) => (
                <Checkbox
                  label="Generate audio"
                  description="Generate audio along with the video"
                  checked={value}
                  onChange={(e) => onChange(e.currentTarget.checked)}
                />
              )}
            />

            {/* Wan: Draft mode toggle (v2.2-5b) */}
            <Controller
              graph={graph}
              name="draft"
              render={({ value, onChange }) => (
                <Checkbox
                  checked={value}
                  onChange={(e) => onChange(e.target.checked)}
                  label="Draft Mode"
                  description="Generate faster at lower quality"
                />
              )}
            />

            {/* Wan: Shift parameter (v2.2, v2.2-5b) */}
            <Controller
              graph={graph}
              name="shift"
              render={({ value, meta, onChange }) => (
                <SliderInput
                  value={value}
                  onChange={onChange}
                  label="Shift"
                  min={meta.min}
                  max={meta.max}
                  step={meta.step}
                />
              )}
            />

            {/* Wan: Interpolator model selector (v2.2) */}
            <Controller
              graph={graph}
              name="interpolatorModel"
              render={({ value, meta, onChange }) => (
                <SelectInput
                  value={value}
                  onChange={(v) => onChange(v as typeof value)}
                  label="Interpolator"
                  options={meta.options}
                />
              )}
            />

            {/* Wan: Draft mode toggle (v2.2) */}
            {/* <Controller
              graph={graph}
              name="draft"
              render={({ value, onChange }) => (
                <Checkbox
                  checked={value}
                  onChange={(e) => onChange(e.target.checked)}
                  label="Turbo Mode"
                  description="Generate faster with optimized settings"
                />
              )}
            /> */}
          </AccordionLayout>
        </Stack>
      </div>
      <FormFooter
        onSubmitSuccess={
          snapshot.workflow && isEnhancementWorkflow(snapshot.workflow)
            ? handleNavigationBack
            : undefined
        }
      />
    </div>
  );
}

function ControllerLabel({ label, info }: { label: React.ReactNode; info?: string }) {
  if (!info) return <Input.Label>{label}</Input.Label>;
  return (
    <div className="flex items-center gap-1">
      <Input.Label>{label}</Input.Label>
      <InfoPopover size="xs" iconProps={{ size: 14 }}>
        {info}
      </InfoPopover>
    </div>
  );
}

/**
 * Find the path through a VersionGroup tree that matches a given model ID.
 * Returns an array of VersionOptions from root to leaf, or null if not found.
 */
function findModelPath(group: VersionGroup, modelId: number): VersionOption[] | null {
  for (const opt of group.options) {
    // Check children first (deeper match takes priority over parent default value)
    if (opt.children) {
      const subPath = findModelPath(opt.children, modelId);
      if (subPath) return [opt, ...subPath];
    } else if (opt.value === modelId) {
      return [opt];
    }
  }
  return null;
}

/** Compact dropdown for a single level in a version hierarchy. */
function VersionLevelDropdown({
  group,
  selectedValue,
  onChange,
}: {
  group: VersionGroup;
  selectedValue: number;
  onChange: (id: number) => void;
}) {
  const selected = group.options.find((o) => o.value === selectedValue) ?? group.options[0];
  return (
    <Menu position="bottom-start" withinPortal>
      <Tooltip label={group.label} position="top" withArrow disabled={!group.label}>
        <Menu.Target>
          <UnstyledButton
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-3 py-2 text-xs font-semibold',
              'bg-gray-1 hover:bg-gray-2',
              'dark:bg-dark-5 dark:hover:bg-dark-4'
            )}
          >
            {selected?.label}
          </UnstyledButton>
        </Menu.Target>
      </Tooltip>
      <Menu.Dropdown>
        {group.options.map((option) => (
          <Menu.Item
            key={option.value}
            onClick={() => onChange(option.value)}
            className={clsx(selectedValue === option.value && 'bg-blue-5/10 dark:bg-blue-8/20')}
          >
            {option.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * Hierarchical version selector for multi-level model version selection.
 * Walks a VersionGroup tree and renders a compact inline dropdown for each level.
 * Used for ecosystems like HiDream where model selection has multiple axes (precision → variant).
 */
function VersionGroupSelector({
  versions,
  modelId,
  onChange,
}: {
  versions: VersionGroup;
  modelId: number | undefined;
  onChange: (value: { id: number }) => void;
}) {
  const allIds = useMemo(() => getAllVersionIds(versions), [versions]);
  const { registerResourceId, unregisterResourceId, getResourceData } = useResourceDataContext();

  // Pre-register all version IDs for batch-fetching
  useEffect(() => {
    if (allIds.size === 0) return;
    allIds.forEach(registerResourceId);
    return () => {
      allIds.forEach(unregisterResourceId);
    };
  }, [allIds, registerResourceId, unregisterResourceId]);

  const handleChange = useCallback(
    (id: number) => {
      const resourceData = getResourceData(id);
      onChange(resourceData ?? { id });
    },
    [getResourceData, onChange]
  );

  // Only render if current model is a known version in the tree
  if (!modelId || !allIds.has(modelId)) return null;

  const path = findModelPath(versions, modelId);

  // Build levels to render by walking the tree along the selected path
  const levels: Array<{ group: VersionGroup; selectedValue: number }> = [];
  let currentGroup: VersionGroup | undefined = versions;
  let pathIdx = 0;

  while (currentGroup && currentGroup.options.length > 0) {
    const selected: VersionOption = path?.[pathIdx] ?? currentGroup.options[0];
    levels.push({ group: currentGroup, selectedValue: selected.value });
    currentGroup = selected.children;
    pathIdx++;
  }

  const leaf = levels[levels.length - 1];

  return (
    <div className="flex items-center gap-1">
      {/* Parent levels: compact dropdown */}
      {levels.slice(0, -1).map((level, i) => (
        <VersionLevelDropdown
          key={level.group.label ?? i}
          group={level.group}
          selectedValue={level.selectedValue}
          onChange={handleChange}
        />
      ))}
      {/* Leaf level: inline button group, fills remaining width */}
      {leaf && (
        <ButtonGroupInput
          className="flex-1"
          value={leaf.selectedValue.toString()}
          onChange={(v) => handleChange(Number(v))}
          data={leaf.group.options.map((o) => ({ label: o.label, value: o.value.toString() }))}
        />
      )}
    </div>
  );
}
