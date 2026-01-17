/**
 * DataGraph V2 Demo Page
 *
 * Demonstrates the DataGraph with Controller pattern for explicit form control.
 * This is feature-parity with data-graph-standalone.tsx but uses Controller instead of RenderNodes.
 * Access at: /data-graph-v2
 *
 * Key difference from RenderNodes approach:
 * - Static props (label, buttonLabel, placeholder, etc.) are defined inline in the component
 * - Only dynamic props (options, min/max from context, etc.) come from meta
 */

import {
  Button,
  Card,
  Collapse,
  Container,
  Group,
  Modal,
  NumberInput,
  Stack,
  Text,
  ActionIcon,
  SegmentedControl,
  Checkbox,
  Input,
  Radio,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconArrowRight } from '@tabler/icons-react';
import React, { type ReactNode, useState, useCallback } from 'react';
import clsx from 'clsx';

import { IsClient } from '~/components/IsClient/IsClient';
import { ResourceDataProvider } from '~/components/generation_v2/inputs/ResourceDataProvider';
import { useCompatibilityInfo } from '~/components/generation_v2/hooks/useCompatibilityInfo';
import { createLocalStorageAdapter } from '~/libs/data-graph/storage-adapter';
import { DataGraphProvider, useGraph, Controller } from '~/libs/data-graph/react';
import {
  generationGraph,
  type GenerationGraphTypes,
  type GenerationCtx,
  type VideoValue,
} from '~/shared/data-graph/generation';

// Input components
import { BaseModelInput } from '~/components/generation_v2/inputs/BaseModelInput';
import { WorkflowInput } from '~/components/generation_v2/inputs/WorkflowInput';
import { ResourceSelectInput } from '~/components/generation_v2/inputs/ResourceSelectInput';
import { ResourceSelectMultipleInput } from '~/components/generation_v2/inputs/ResourceSelectMultipleInput';
import { PromptInput } from '~/components/generation_v2/inputs/PromptInput';
import {
  AspectRatioInput,
  type AspectRatioValue,
} from '~/components/generation_v2/inputs/AspectRatioInput';
import { SliderInput } from '~/components/generation_v2/inputs/SliderInput';
import { SelectInput } from '~/components/generation_v2/inputs/SelectInput';
import { SeedInput } from '~/components/generation_v2/inputs/SeedInput';
import { ImageUploadMultipleInput } from '~/components/generation_v2/inputs/ImageUploadMultipleInput';
import { VideoInput } from '~/components/generation_v2/inputs/VideoInput';
import { InterpolationFactorInput } from '~/components/generation_v2/inputs/InterpolationFactorInput';
import { OverflowSegmentedControl } from '~/components/generation_v2/inputs/OverflowSegmentedControl';
import { PriorityInput } from '~/components/generation_v2/inputs/PriorityInput';
import { OutputFormatInput } from '~/components/generation_v2/inputs/OutputFormatInput';

const STORAGE_KEY = 'data-graph-v2';

// =============================================================================
// Form Footer Component
// =============================================================================

function FormFooter() {
  const graph = useGraph<GenerationGraphTypes>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    const result = graph.validate();
    if (!result.success) {
      console.log('Validation failed:', result.errors);
      return;
    }

    setIsSubmitting(true);
    try {
      const inputData = Object.fromEntries(
        Object.entries(result.data).filter(([k]) => result.nodes[k]?.kind !== 'computed')
      );
      console.log('Submitting:', inputData);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReset = () => {
    // Don't exclude 'model' - it should be reset to match the baseModel
    // The checkpointNode factory will select a default model for the baseModel
    graph.reset({ exclude: ['workflow', 'baseModel'] });
  };

  return (
    <div className="shadow-topper sticky bottom-0 z-10 flex gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
      <Controller
        graph={graph}
        name="quantity"
        render={({ value, meta, onChange }) => (
          <Card withBorder className="flex max-w-[88px] flex-col p-0">
            <Text className="pr-6 text-center text-xs font-semibold" c="dimmed">
              Quantity
            </Text>
            <NumberInput
              value={value ?? 1}
              onChange={(val) => onChange(Number(val) || 1)}
              min={meta.min}
              max={meta.max}
              step={meta.step}
              size="md"
              variant="unstyled"
              styles={{
                input: {
                  textAlign: 'center',
                  fontWeight: 700,
                  fontSize: 20,
                  padding: 0,
                },
              }}
            />
          </Card>
        )}
      />
      <Button className="h-auto flex-1" onClick={handleSubmit} loading={isSubmitting}>
        Submit
      </Button>
      <Button onClick={handleReset} variant="default" className="h-auto px-3">
        Reset
      </Button>
    </div>
  );
}

// =============================================================================
// Accordion Layout Component
// =============================================================================

interface AccordionLayoutProps {
  children: ReactNode;
  label: string;
  storeKey?: string;
  defaultOpen?: boolean;
}

function AccordionLayout({ children, label, storeKey, defaultOpen = true }: AccordionLayoutProps) {
  const [storedOpened, setStoredOpened] = useLocalStorage<boolean>({
    key: storeKey ?? '__unused__',
    defaultValue: defaultOpen,
  });
  const [localOpened, setLocalOpened] = useState(defaultOpen);

  const opened = storeKey ? storedOpened : localOpened;
  const toggle = () => {
    if (storeKey) {
      setStoredOpened((prev) => !prev);
    } else {
      setLocalOpened((prev) => !prev);
    }
  };

  // Hide accordion when content has no visible children using :has() with child selector
  // Shows only when .accordion-content has at least one child element
  return (
    <Card withBorder padding={0} className="hidden has-[.accordion-content>*]:block">
      <Card.Section
        withBorder={opened}
        inheritPadding
        py="xs"
        px="sm"
        onClick={toggle}
        className="cursor-pointer select-none"
      >
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600}>{label}</Text>
          <ActionIcon
            component="div"
            variant="subtle"
            size="sm"
            className={clsx('transition-transform', { 'rotate-180': opened })}
          >
            <IconChevronDown size={16} />
          </ActionIcon>
        </Group>
      </Card.Section>

      <Collapse in={opened}>
        <Card.Section inheritPadding py="sm" px="sm">
          <div className="accordion-content flex flex-col gap-3">{children}</div>
        </Card.Section>
      </Collapse>
    </Card>
  );
}

// =============================================================================
// Pending Change Types for Confirmation Modal
// =============================================================================

type PendingChange =
  | {
      type: 'workflow';
      value: string;
      workflowLabel: string;
      currentEcosystem: string;
      targetEcosystem: string;
    }
  | {
      type: 'ecosystem';
      value: string;
      ecosystemLabel: string;
      currentWorkflow: string;
      targetWorkflow: string;
    };

// =============================================================================
// Confirmation Modal Component
// =============================================================================

interface CompatibilityConfirmModalProps {
  pendingChange: PendingChange | null;
  onConfirm: () => void;
  onCancel: () => void;
}

function CompatibilityConfirmModal({
  pendingChange,
  onConfirm,
  onCancel,
}: CompatibilityConfirmModalProps) {
  if (!pendingChange) return null;

  const isWorkflowChange = pendingChange.type === 'workflow';

  return (
    <Modal
      opened
      onClose={onCancel}
      title={isWorkflowChange ? 'Change ecosystem?' : 'Change workflow?'}
      size="sm"
    >
      <Stack gap="md">
        <Text size="sm">
          {isWorkflowChange ? (
            <>
              <strong>{pendingChange.workflowLabel}</strong> is not available for{' '}
              <strong>{pendingChange.currentEcosystem}</strong>.
            </>
          ) : (
            <>
              <strong>{pendingChange.ecosystemLabel}</strong> doesn&apos;t support{' '}
              <strong>{pendingChange.currentWorkflow}</strong>.
            </>
          )}
        </Text>

        <Card withBorder p="sm" className="bg-gray-0 dark:bg-dark-6">
          <Group gap="sm" wrap="nowrap">
            <Text size="sm" c="dimmed">
              {isWorkflowChange ? 'Ecosystem' : 'Workflow'}
            </Text>
            <Text size="sm" fw={500} className="line-through opacity-60">
              {isWorkflowChange ? pendingChange.currentEcosystem : pendingChange.currentWorkflow}
            </Text>
            <IconArrowRight size={14} className="text-gray-5" />
            <Text size="sm" fw={600} c="blue">
              {isWorkflowChange ? pendingChange.targetEcosystem : pendingChange.targetWorkflow}
            </Text>
          </Group>
        </Card>

        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Continue</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// =============================================================================
// Main Form Component using Controller Pattern
// =============================================================================

function GenerationForm() {
  const graph = useGraph<GenerationGraphTypes>();
  // Access graph snapshot directly for workflow/baseModel (they exist in discriminated branches)
  const snapshot = graph.getSnapshot() as { workflow?: string; baseModel?: string };
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  // Force re-render when workflow or baseModel changes
  // Use loose typing for subscribe since baseModel is in a discriminated branch
  const [, forceUpdate] = useState({});
  React.useEffect(() => {
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

          setPendingChange({
            type: 'workflow',
            value: newWorkflow,
            workflowLabel,
            currentEcosystem: currentEcoName,
            targetEcosystem: target.displayName,
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
        setPendingChange({
          type: 'ecosystem',
          value: newBaseModel,
          ecosystemLabel,
          currentWorkflow: snapshot.workflow ?? 'txt2img',
          targetWorkflow: target.label,
        });
        return;
      }
      graph.set({ baseModel: newBaseModel } as Parameters<typeof graph.set>[0]);
    },
    [compatibility, graph, snapshot.workflow]
  );

  // Confirm pending change
  const confirmChange = useCallback(() => {
    if (!pendingChange) return;
    if (pendingChange.type === 'workflow') {
      graph.set({ workflow: pendingChange.value } as Parameters<typeof graph.set>[0]);
    } else {
      graph.set({ baseModel: pendingChange.value } as Parameters<typeof graph.set>[0]);
    }
    setPendingChange(null);
  }, [pendingChange, graph]);

  // Cancel pending change
  const cancelChange = useCallback(() => {
    setPendingChange(null);
  }, []);

  return (
    <div className="flex size-full flex-1 flex-col">
      {/* Confirmation modal for incompatible selections */}
      <CompatibilityConfirmModal
        pendingChange={pendingChange}
        onConfirm={confirmChange}
        onCancel={cancelChange}
      />

      <div className="flex-1 overflow-auto px-3 py-2">
        <Stack gap="sm" className="w-full">
          {/* Feature selector - primary way users select what they want to do */}
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

          {/* Base model selector */}
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
                label="Base Model"
                compatibleEcosystems={meta?.compatibleEcosystems}
                disabled={meta?.disabled}
                isCompatible={compatibility.isEcosystemKeyCompatible}
                targetWorkflow={compatibility.getTargetWorkflowForEcosystem().label}
                outputType={compatibility.currentOutputType}
              />
            )}
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
            render={({ value, meta, onChange }) => (
              <ImageUploadMultipleInput
                value={value}
                onChange={onChange}
                aspect="video"
                max={meta?.max}
                slots={meta?.slots}
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
            render={({ value, onChange, meta }) => (
              <PromptInput
                value={value}
                onChange={onChange}
                label="Prompt"
                placeholder="Your prompt goes here..."
                autosize
                minRows={2}
                required={meta.required}
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

// =============================================================================
// Storage Adapter
// =============================================================================

const storageAdapter = createLocalStorageAdapter({
  prefix: STORAGE_KEY,
  groups: [
    // Workflow is the primary selector - stored globally
    { keys: ['workflow', 'outputFormat', 'priority'] },
    { name: 'output', keys: ['baseModel'], scope: 'output' },
    { name: 'common', keys: ['prompt', 'negativePrompt', 'seed', 'quantity'] },
    // baseModel is scoped to workflow (different workflows may use different ecosystems)
    // { name: 'workflow', keys: ['baseModel'], scope: 'workflow' },
    {
      name: 'workflow',
      keys: ['quantity'],
      scope: 'workflow',
      condition: (ctx) => ctx.workflow === 'txt2img:draft',
    },
    // Common settings shared across all workflows
    // Model-family specific settings scoped to baseModel
    // Values for inactive nodes are automatically retained in storage
    // (e.g., cfgScale/steps when switching to Ultra mode which doesn't have them)
    { name: 'scoped', keys: '*', scope: 'baseModel' },
  ],
});

// =============================================================================
// Main Demo Component
// =============================================================================

function DataGraphV2Demo() {
  const externalContext: GenerationCtx = {
    limits: {
      maxQuantity: 12,
      maxSteps: 50,
      maxResolution: 1280,
      maxResources: 12,
    },
    user: {
      isMember: true,
      tier: 'pro',
    },
    resources: [],
  };

  return (
    <Container size="xs" className="h-screen max-h-screen w-full overflow-hidden px-0 py-3">
      <IsClient>
        <ResourceDataProvider>
          <DataGraphProvider
            graph={generationGraph}
            storage={storageAdapter}
            externalContext={externalContext}
            debug
          >
            <GenerationForm />
          </DataGraphProvider>
        </ResourceDataProvider>
      </IsClient>
    </Container>
  );
}

// =============================================================================
// Page Export
// =============================================================================

export default function DataGraphV2Page() {
  return <DataGraphV2Demo />;
}

DataGraphV2Page.standalone = true;
