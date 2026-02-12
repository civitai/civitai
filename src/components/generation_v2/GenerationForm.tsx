/**
 * GenerationForm
 *
 * Main form component for the generation UI using the Controller pattern.
 * Handles workflow/ecosystem selection with compatibility checks.
 */

import {
  Button,
  Checkbox,
  Divider,
  Group,
  Input,
  Paper,
  Radio,
  Stack,
  Tabs,
  Text,
} from '@mantine/core';
import React, { useCallback, useState, useRef, useEffect } from 'react';

import { CopyButton } from '~/components/CopyButton/CopyButton';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { Controller, MultiController, useGraph } from '~/libs/data-graph/react';
import {
  type GenerationGraphTypes,
  type VideoValue,
  wanVersionOptions,
  ecosystemToVersionDef,
  wanVersionDefs,
} from '~/shared/data-graph/generation';
import { getWorkflowModes } from '~/shared/data-graph/generation/config';
import { ecosystemById } from '~/shared/constants/basemodel.constants';

import { useCompatibilityInfo } from './hooks/useCompatibilityInfo';
import { AccordionLayout } from './AccordionLayout';
import { openCompatibilityConfirmModal } from './CompatibilityConfirmModal';
import { FormFooter } from './FormFooter';
import { ResourceAlerts, ExperimentalModelAlert, ReadyAlert } from './ResourceAlerts';

// Input components
import { BaseModelInput } from './inputs/BaseModelInput';
import { WorkflowInput, SelectedWorkflowDisplay } from './inputs/WorkflowInput';
import { ResourceSelectInput } from './inputs/ResourceSelectInput';
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
import { SegmentedControlWrapper } from '~/libs/form/components/SegmentedControlWrapper';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';

// =============================================================================
// Component
// =============================================================================

export function GenerationForm() {
  const graph = useGraph<GenerationGraphTypes>();
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

  // Handle workflow selection with compatibility check
  // Receives (graphKey, ecosystemIds) from WorkflowInput — ecosystemIds are per-entry (not aggregated)
  const handleWorkflowChange = useCallback(
    (graphKey: string, ecosystemIds: number[]) => {
      // Check if the selected entry is compatible with the current ecosystem
      const isEntryCompatible =
        ecosystemIds.length === 0 ||
        (compatibility.currentEcosystemId !== undefined &&
          ecosystemIds.includes(compatibility.currentEcosystemId));

      if (!isEntryCompatible) {
        // Find target ecosystem from the entry's ecosystemIds
        const targetEcoId = ecosystemIds[0];
        const target = targetEcoId !== undefined ? ecosystemById.get(targetEcoId) : undefined;
        if (target && compatibility.currentEcosystemKey) {
          openCompatibilityConfirmModal({
            pendingChange: {
              type: 'workflow',
              value: graphKey,
              currentEcosystem: compatibility.currentEcosystemKey,
              targetEcosystem: target.displayName,
            },
            onConfirm: () => {
              graphRef.current.set({
                workflow: graphKey,
                ecosystem: target.key,
              } as Parameters<typeof graph.set>[0]);
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
      <div className="flex-1 overflow-auto px-3 py-2">
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
              if (modes.length > 0) {
                return (
                  <SegmentedControlWrapper
                    value={value as string}
                    onChange={(v) => graph.set({ workflow: v } as Parameters<typeof graph.set>[0])}
                    data={modes}
                    fullWidth
                  />
                );
              }
              return (
                <SelectedWorkflowDisplay
                  workflowId={value as string}
                  ecosystemId={compatibility.currentEcosystemId}
                />
              );
            }}
          />

          {/* Checkpoint/Model selector with version selector */}
          <Controller
            graph={graph}
            name="model"
            render={({ value, meta, onChange }) => (
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
                versions={meta.versions}
              />
            )}
          />

          {/* Wan version picker */}
          <Controller
            graph={graph}
            name="wanVersion"
            render={({ value }) => (
              <SegmentedControlWrapper
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
                  (graph as { set: (v: Record<string, unknown>) => void }).set({ ecosystem: eco });
                }}
                data={wanVersionOptions}
              />
            )}
          />

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
                aspect="video"
                max={meta?.max}
                slots={meta?.slots}
                error={error?.message}
              />
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

          {/* Scale factor (img2img:upscale, vid2vid:upscale) */}
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
                  px="sm"
                  radius="md"
                  withBorder
                  className="bg-white focus-within:border-blue-6 dark:bg-dark-6 dark:focus-within:border-blue-8"
                >
                  <PromptInput
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
              const options = (meta as { options: { label: string; value: number }[] })?.options;
              const disabled = (meta as { disabled?: boolean })?.disabled;
              return (
                <div className="flex flex-col gap-1">
                  <Input.Label>Duration</Input.Label>
                  <SegmentedControlWrapper
                    value={value}
                    onChange={(v) => onChange(v)}
                    data={
                      options?.map((o) => ({ label: o.label, value: o.value })) ?? []
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

            {/* Wan: Turbo mode toggle (v2.2) */}
            <Controller
              graph={graph}
              name="useTurbo"
              render={({ value, onChange }) => (
                <Checkbox
                  checked={value}
                  onChange={(e) => onChange(e.target.checked)}
                  label="Turbo Mode"
                  description="Generate faster with optimized settings"
                />
              )}
            />

            {/* Kling: Generation mode (standard/professional) */}
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
          </AccordionLayout>
        </Stack>
      </div>
      <FormFooter />
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