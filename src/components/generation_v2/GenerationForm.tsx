/**
 * GenerationForm
 *
 * Main form component for the generation UI using the Controller pattern.
 * Handles workflow/ecosystem selection with compatibility checks.
 */

import { Checkbox, Group, Input, Radio, SegmentedControl, Stack } from '@mantine/core';
import React, { useCallback, useState, useRef, useEffect } from 'react';

import { Controller, useGraph } from '~/libs/data-graph/react';
import { type GenerationGraphTypes, type VideoValue } from '~/shared/data-graph/generation';

import { useCompatibilityInfo } from './hooks/useCompatibilityInfo';
import { AccordionLayout } from './AccordionLayout';
import { openCompatibilityConfirmModal, type PendingChange } from './CompatibilityConfirmModal';
import { FormFooter } from './FormFooter';

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
import { OverflowSegmentedControl } from './inputs/OverflowSegmentedControl';
import { PriorityInput } from './inputs/PriorityInput';
import { OutputFormatInput } from './inputs/OutputFormatInput';

// =============================================================================
// Component
// =============================================================================

export function GenerationForm() {
  const graph = useGraph<GenerationGraphTypes>();
  // Access graph snapshot directly for workflow/baseModel (they exist in discriminated branches)
  const snapshot = graph.getSnapshot() as { workflow?: string; baseModel?: string };
  // Force re-render when workflow or baseModel changes
  // Use loose typing for subscribe since baseModel is in a discriminated branch
  const [, forceUpdate] = useState({});
  useEffect(() => {
    const unsubWorkflow = graph.subscribe('workflow', () => forceUpdate({}));
    type LooseGraph = { subscribe: (key: string, cb: () => void) => () => void };
    const unsubBaseModel = (graph as LooseGraph).subscribe('baseModel', () => forceUpdate({}));
    return () => {
      unsubWorkflow();
      unsubBaseModel();
    };
  }, [graph]);

  // Get compatibility info based on current workflow and baseModel
  const compatibility = useCompatibilityInfo({
    workflow: snapshot.workflow,
    baseModel: snapshot.baseModel,
  });

  // Use ref to store the graph instance for callbacks (avoids stale closure)
  const graphRef = useRef(graph);
  graphRef.current = graph;

  // Handle workflow selection with compatibility check
  const handleWorkflowChange = useCallback(
    (newWorkflow: string, workflowLabel: string) => {
      if (!compatibility.isWorkflowCompatible(newWorkflow)) {
        const target = compatibility.getTargetEcosystemForWorkflow(newWorkflow);
        if (target && compatibility.currentEcosystemKey) {
          // Get current ecosystem display name
          const currentEcoName =
            graph
              .getNodeMeta('baseModel')
              ?.compatibleEcosystems?.find(
                (key: string) => key === compatibility.currentEcosystemKey
              ) ?? compatibility.currentEcosystemKey;

          openCompatibilityConfirmModal({
            pendingChange: {
              type: 'workflow',
              value: newWorkflow,
              workflowLabel,
              currentEcosystem: currentEcoName,
              targetEcosystem: target.displayName,
            },
            onConfirm: () => {
              graphRef.current.set({ workflow: newWorkflow } as Parameters<typeof graph.set>[0]);
            },
          });
          return;
        }
      }
      graph.set({ workflow: newWorkflow } as Parameters<typeof graph.set>[0]);
    },
    [compatibility, graph]
  );

  // Handle ecosystem selection with compatibility check
  const handleBaseModelChange = useCallback(
    (newBaseModel: string, ecosystemLabel: string) => {
      if (!compatibility.isEcosystemKeyCompatible(newBaseModel)) {
        const target = compatibility.getTargetWorkflowForEcosystem();
        openCompatibilityConfirmModal({
          pendingChange: {
            type: 'ecosystem',
            value: newBaseModel,
            ecosystemLabel,
            currentWorkflow: snapshot.workflow ?? 'txt2img',
            targetWorkflow: target.label,
          },
          onConfirm: () => {
            graphRef.current.set({ baseModel: newBaseModel } as Parameters<typeof graph.set>[0]);
          },
        });
        return;
      }
      graph.set({ baseModel: newBaseModel } as Parameters<typeof graph.set>[0]);
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
                  onChange={(newValue) => {
                    // Get workflow label for the modal
                    const label = newValue; // WorkflowInput doesn't expose label, using value
                    handleWorkflowChange(newValue, label);
                  }}
                  isCompatible={compatibility.isWorkflowCompatible}
                />
              )}
            />

            <Controller
              graph={graph}
              name="baseModel"
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
                  targetWorkflow={compatibility.getTargetWorkflowForEcosystem().label}
                  outputType={compatibility.currentOutputType}
                />
              )}
            />
          </Group>

          {/* Selected workflow display */}
          <Controller
            graph={graph}
            name="workflow"
            render={({ value }) => <SelectedWorkflowDisplay workflowId={value} />}
          />

          {/* Checkpoint/Model selector with version selector */}
          <Controller
            graph={graph}
            name="model"
            render={({ value, meta, onChange }) => {
              const versionIds = meta.versions?.map((x) => x.value) ?? [];
              const showVersionSelector = value?.id !== undefined && versionIds.includes(value.id);

              return (
                <>
                  <ResourceSelectInput
                    value={value as any}
                    onChange={onChange as any}
                    label="Model"
                    buttonLabel="Select Model"
                    modalTitle="Select Model"
                    options={meta.options}
                    allowRemove={false}
                    allowSwap={!meta.modelLocked}
                  />
                  {/* Version selector (for models with multiple versions like Flux modes) */}

                  {showVersionSelector && meta.versions && (
                    <OverflowSegmentedControl
                      value={value?.id?.toString()}
                      onChange={(stringId) => onChange({ id: Number(stringId) } as any)}
                      options={meta.versions.map(({ label, value }) => ({
                        label,
                        value: value.toString(),
                      }))}
                      maxVisible={5}
                    />
                  )}
                </>
              );
            }}
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

          {/* Source images (img2img only) */}
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
              <VideoInput value={value} onChange={(v) => onChange(v as VideoValue | undefined)} />
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

          {/* Prompt */}
          <Controller
            graph={graph}
            name="prompt"
            render={({ value, onChange, meta, error }) => (
              <PromptInput
                value={value}
                onChange={onChange}
                label="Prompt"
                placeholder="Your prompt goes here..."
                autosize
                minRows={2}
                required={meta.required}
                error={error?.message}
              />
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
                  <SegmentedControl
                    value={value?.toString()}
                    onChange={(v) => onChange(Number(v))}
                    data={
                      options?.map((o) => ({ label: o.label, value: o.value.toString() })) ?? []
                    }
                    disabled={disabled}
                  />
                </div>
              );
            }}
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
            {/* CFG Scale / Guidance - label varies by model family */}
            <Controller
              graph={graph}
              name="cfgScale"
              render={({ value, meta, onChange }) => (
                <SliderInput
                  value={value}
                  onChange={onChange}
                  label="CFG Scale"
                  min={meta.min}
                  max={meta.max}
                  step={meta.step}
                  presets={meta.presets}
                />
              )}
            />

            {/* Sampler (SD only) */}
            <Controller
              graph={graph}
              name="sampler"
              render={({ value, meta, onChange }) => (
                <SelectInput
                  value={value}
                  onChange={onChange}
                  label="Sampler"
                  options={meta.options}
                  presets={meta.presets}
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
                  label="Steps"
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
                  <Input.Label>Movement Amplitude</Input.Label>
                  <SegmentedControl
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
                  label="VAE"
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
          </AccordionLayout>
        </Stack>
      </div>
      <FormFooter />
    </div>
  );
}
