import { Checkbox, Input, Stack } from '@mantine/core';
import { Controller, MultiController } from 'form-graph/react';

import { ActiveWildcards } from '~/components/Generate/Input/ActiveWildcards';
import { GenerationTextEditor } from '~/components/Generate/Input/GenerationTextEditor';
import { ResourceAlerts } from '~/components/generation_v2/ResourceAlerts';
import { AspectRatioInput } from '~/components/generation_v2/inputs/AspectRatioInput';
import { BaseModelInput } from '~/components/generation_v2/inputs/BaseModelInput';
import { ImageUploadMultipleInput } from '~/components/generation_v2/inputs/ImageUploadMultipleInput';
import { ResourceSelectInput } from '~/components/generation_v2/inputs/ResourceSelectInput';
import { ResourceSelectMultipleInput } from '~/components/generation_v2/inputs/ResourceSelectMultipleInput';
import { SeedInput } from '~/components/generation_v2/inputs/SeedInput';
import { SelectInput } from '~/components/generation_v2/inputs/SelectInput';
import { SliderInput } from '~/components/generation_v2/inputs/SliderInput';
import { VideoInput } from '~/components/generation_v2/inputs/VideoInput';
import { ButtonGroupInput } from '~/libs/form/components/ButtonGroupInput';
import { SegmentedControlWrapper } from '~/libs/form/components/SegmentedControlWrapper';
import { videoHub } from '~/shared/form-graph/generation/video/hub.graph';
import { wanVersionDefs, wanVersionOptions } from '~/shared/form-graph/generation/video/wan.graph';

import { ControllerLabel, VersionGroupSelector, useWildcardHandlers } from './form-helpers';
import type { GenerationStore } from './store';

/**
 * The VIDEO generation form — `<Controller graph={videoHub}>` per field with
 * the generation_v2 input components. The wan version picker mirrors v2's:
 * it sets the ECOSYSTEM (the version tag is computed from it).
 */

export function VideoGenerationForm({ store }: { store: GenerationStore }) {
  const wildcards = useWildcardHandlers(store);

  return (
    <Stack gap="sm">
      <Controller
        graph={videoHub}
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
      <div className="flex flex-col gap-1">
        <Controller
          graph={videoHub}
          name="model"
          render={({ value, meta, onChange }) => {
            const defaultModelId = meta?.defaultModelId;
            return (
              <>
                <ResourceSelectInput
                  value={value}
                  onChange={onChange}
                  label={<ControllerLabel label="Model" />}
                  buttonLabel="Select Model"
                  modalTitle="Select Model"
                  options={meta?.options}
                  allowRemove={false}
                  allowSwap={!meta?.modelLocked}
                  onRevertToDefault={
                    defaultModelId
                      ? () => onChange({ id: defaultModelId, model: { type: 'Checkpoint' } })
                      : undefined
                  }
                />
                {meta?.versions ? (
                  <VersionGroupSelector
                    versions={meta.versions}
                    modelId={value?.id}
                    onChange={onChange}
                  />
                ) : null}
              </>
            );
          }}
        />
        <Controller
          graph={videoHub}
          name="wanVersion"
          render={({ value }) => (
            <ButtonGroupInput
              // the tag types | undefined across arms; when this renders, a wan
              // arm is active and the tag is set
              value={value ?? ''}
              onChange={(v: string) => {
                const def = wanVersionDefs.find((d) => d.version === v);
                if (!def) return;
                const snap = store.getSnapshot().state as { workflow?: string };
                const isImg2vid = snap.workflow === 'img2vid';
                // Set ecosystem directly — wanVersion is computed from it.
                // v2.1: always T2V; the graph derives the resolution-dependent I2V backend.
                const eco =
                  isImg2vid && def.version !== 'v2.1' ? def.ecosystems.i2v : def.ecosystems.t2v;
                store.set({ ecosystem: eco });
              }}
              data={wanVersionOptions}
            />
          )}
        />
      </div>
      <Controller
        graph={videoHub}
        name="images"
        render={({ value, meta, onChange, error }) => (
          <ImageUploadMultipleInput
            label="Source images"
            value={value}
            onChange={onChange}
            max={meta?.max}
            slots={meta?.slots}
            warnOnMissingAiMetadata={meta?.warnOnMissingAiMetadata}
            aspectRatios={meta?.aspectRatios as `${number}:${number}`[] | undefined}
            error={error?.message}
          />
        )}
      />
      <Controller
        graph={videoHub}
        name="video"
        render={({ value, onChange }) => <VideoInput value={value} onChange={onChange} />}
      />
      <Controller
        graph={videoHub}
        name="resources"
        render={({ value, meta, onChange }) => (
          <ResourceSelectMultipleInput
            value={value}
            onChange={onChange}
            label="Additional Resources"
            buttonLabel="Add LoRA"
            modalTitle="Select Resources"
            options={meta?.options}
            limit={meta?.limit}
          />
        )}
      />
      <MultiController
        graph={videoHub}
        names={['model', 'resources'] as const}
        render={({ values }) => (
          <ResourceAlerts model={values.model} resources={values.resources} />
        )}
      />
      <Controller
        graph={videoHub}
        name="snippets"
        render={() => (
          <ActiveWildcards
            onRemoveSet={wildcards.removeWildcardSet}
            onAdd={wildcards.addWildcardSet}
            isAdding={wildcards.isAdding}
          />
        )}
      />
      <Controller
        graph={videoHub}
        name="prompt"
        render={({ value, meta, onChange, error }) => (
          <GenerationTextEditor
            value={value}
            onChange={onChange}
            snippets={meta?.snippets}
            triggerWords={meta?.triggerWords}
            attentionEdit
            label={
              <ControllerLabel
                label="Prompt"
                info="Type out what you'd like to generate."
                required={meta?.required}
              />
            }
            placeholder="Your prompt goes here..."
            error={error?.message}
          />
        )}
      />
      <Controller
        graph={videoHub}
        name="negativePrompt"
        render={({ value, meta, onChange }) => (
          <GenerationTextEditor
            value={value}
            onChange={onChange}
            snippets={meta?.snippets}
            triggerWords={meta?.triggerWords}
            attentionEdit
            label="Negative Prompt"
            placeholder="What to avoid..."
            minRows={1}
          />
        )}
      />
      <Controller
        graph={videoHub}
        name="resolution"
        render={({ value, meta, onChange }) => (
          <div className="flex flex-col gap-1">
            <Input.Label>Resolution</Input.Label>
            <SegmentedControlWrapper
              value={value}
              onChange={(v) => onChange(v as typeof value)}
              data={(meta?.options ?? []).map((o) => ({ label: o.label, value: String(o.value) }))}
            />
          </div>
        )}
      />
      <Controller
        graph={videoHub}
        name="aspectRatio"
        render={({ value, meta, onChange }) => (
          <AspectRatioInput
            value={value}
            onChange={onChange}
            label="Aspect Ratio"
            options={meta?.options ?? []}
            maxVisible={5}
          />
        )}
      />
      <Controller
        graph={videoHub}
        name="duration"
        render={({ value, meta, onChange }) => {
          if (meta && 'min' in meta) {
            return (
              <SliderInput
                label="Duration (seconds)"
                value={typeof value === 'number' ? value : Number(value)}
                onChange={onChange}
                min={meta.min}
                max={meta.max}
                step={meta.step ?? 1}
              />
            );
          }
          return (
            <div className="flex flex-col gap-1">
              <Input.Label>Duration</Input.Label>
              <SegmentedControlWrapper
                value={String(value)}
                onChange={(v) => {
                  const opt = (meta?.options ?? []).find((o) => String(o.value) === v);
                  if (opt) onChange(opt.value);
                }}
                data={(meta?.options ?? []).map((o) => ({
                  label: o.label,
                  value: String(o.value),
                }))}
              />
            </div>
          );
        }}
      />
      <Controller
        graph={videoHub}
        name="frameGuideStrength"
        render={({ value, meta, onChange }) =>
          meta ? (
            <SliderInput
              value={value}
              onChange={onChange}
              label={
                <ControllerLabel
                  label="Frame Guide Strength"
                  info="Controls how strongly the first/last frame images guide the video generation."
                />
              }
              min={meta.min}
              max={meta.max}
              step={meta.step}
              presets={meta.presets}
            />
          ) : null
        }
      />
      <Controller
        graph={videoHub}
        name="cfgScale"
        render={({ value, meta, onChange }) =>
          meta ? (
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
          ) : null
        }
      />
      <Controller
        graph={videoHub}
        name="steps"
        render={({ value, meta, onChange }) =>
          meta ? (
            <SliderInput
              value={value}
              onChange={onChange}
              label={
                <ControllerLabel label="Steps" info="The number of iterations spent generating." />
              }
              min={meta.min}
              max={meta.max}
              step={meta.step}
              presets={meta.presets}
            />
          ) : null
        }
      />
      <Controller
        graph={videoHub}
        name="cannyLowThreshold"
        render={({ value, meta, onChange }) =>
          meta ? (
            <SliderInput
              value={value}
              onChange={onChange}
              label={
                <ControllerLabel
                  label="Canny Low Threshold"
                  info="Lower threshold for Canny edge detection. Lower values detect more edges."
                />
              }
              min={meta.min}
              max={meta.max}
              step={meta.step}
              presets={meta.presets}
            />
          ) : null
        }
      />
      <Controller
        graph={videoHub}
        name="cannyHighThreshold"
        render={({ value, meta, onChange }) =>
          meta ? (
            <SliderInput
              value={value}
              onChange={onChange}
              label={
                <ControllerLabel
                  label="Canny High Threshold"
                  info="Upper threshold for Canny edge detection. Higher values only keep strong edges."
                />
              }
              min={meta.min}
              max={meta.max}
              step={meta.step}
              presets={meta.presets}
            />
          ) : null
        }
      />
      <Controller
        graph={videoHub}
        name="guideStrength"
        render={({ value, meta, onChange }) =>
          meta ? (
            <SliderInput
              value={value}
              onChange={onChange}
              label={
                <ControllerLabel
                  label="Guide Strength"
                  info="Controls how closely the output follows the source video structure."
                />
              }
              min={meta.min}
              max={meta.max}
              step={meta.step}
              presets={meta.presets}
            />
          ) : null
        }
      />
      <Controller
        graph={videoHub}
        name="numFrames"
        render={({ value, meta, onChange }) =>
          meta ? (
            <SliderInput
              value={value}
              onChange={onChange}
              label="Frames to Extend"
              min={meta.min}
              max={meta.max}
              step={meta.step}
            />
          ) : null
        }
      />
      <Controller
        graph={videoHub}
        name="shift"
        render={({ value, meta, onChange }) =>
          meta ? (
            <SliderInput
              value={value}
              onChange={onChange}
              label="Shift"
              min={meta.min}
              max={meta.max}
              step={meta.step}
            />
          ) : null
        }
      />
      <Controller
        graph={videoHub}
        name="interpolatorModel"
        render={({ value, meta, onChange }) => (
          <SelectInput
            value={value}
            onChange={(v) => onChange(v as typeof value)}
            label="Interpolator"
            options={meta?.options}
          />
        )}
      />
      <Controller
        graph={videoHub}
        name="usePrime"
        render={({ value, onChange }) => (
          <Checkbox
            label="Prime"
            description="Faster generation for a higher cost. Output quality is unchanged."
            checked={value}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        )}
      />
      <Controller
        graph={videoHub}
        name="draft"
        render={({ value, onChange }) => (
          <Checkbox
            checked={value}
            onChange={(e) => onChange(e.target.checked)}
            label="Draft Mode"
            description="Generate faster at with optimized settings (may reduce quality)"
          />
        )}
      />
      <Controller
        graph={videoHub}
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
      <Controller
        graph={videoHub}
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
      <Controller
        graph={videoHub}
        name="seed"
        render={({ value, onChange }) => (
          <SeedInput value={value} onChange={onChange} label="Seed" />
        )}
      />
      <Controller
        graph={videoHub}
        name="quantity"
        render={({ value, meta, onChange }) =>
          meta ? (
            <SliderInput
              value={value}
              onChange={onChange}
              label={<Input.Label>Quantity</Input.Label>}
              min={meta.min}
              max={meta.max}
              step={meta.step}
            />
          ) : null
        }
      />
    </Stack>
  );
}
