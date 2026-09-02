import { Checkbox, Input, Stack, Switch } from '@mantine/core';
import { Controller, MultiController } from 'form-graph/react';

import { ActiveWildcards } from '~/components/Generate/Input/ActiveWildcards';
import { GenerationTextEditor } from '~/components/Generate/Input/GenerationTextEditor';
import { ResourceAlerts } from '~/components/generation_v2/ResourceAlerts';
import { AspectRatioInput } from '~/components/generation_v2/inputs/AspectRatioInput';
import { BaseModelInput } from '~/components/generation_v2/inputs/BaseModelInput';
import { ControlNetsInput } from '~/components/generation_v2/inputs/ControlNetsInput';

import { ImageUploadMultipleInput } from '~/components/generation_v2/inputs/ImageUploadMultipleInput';
import { OutputFormatInput } from '~/components/generation_v2/inputs/OutputFormatInput';
import { PriorityInput } from '~/components/generation_v2/inputs/PriorityInput';
import { ResourceSelectInput } from '~/components/generation_v2/inputs/ResourceSelectInput';
import { ResourceSelectMultipleInput } from '~/components/generation_v2/inputs/ResourceSelectMultipleInput';
import { Krea2StyleReferencesInput } from '~/components/generation_v2/inputs/Krea2StyleReferencesInput';
import { SeedInput } from '~/components/generation_v2/inputs/SeedInput';
import { SelectInput } from '~/components/generation_v2/inputs/SelectInput';
import { SliderInput } from '~/components/generation_v2/inputs/SliderInput';
import { SegmentedControlWrapper } from '~/libs/form/components/SegmentedControlWrapper';
import { imageHub } from '~/shared/form-graph/generation/image/hub.graph';

import { ControllerLabel, VersionGroupSelector, useWildcardHandlers } from './form-helpers';
import type { GenerationStore } from './store';

/**
 * The IMAGE generation form — one `<Controller graph={imageHub}>` per field,
 * wired to the same input components the generation_v2 form uses. The graph
 * decides visibility (an inactive field's controller renders null), so this
 * holds the superset of image fields; `name` and the render props are typed
 * from `imageHub`'s registry.
 */

export function ImageGenerationForm({ store }: { store: GenerationStore }) {
  const wildcards = useWildcardHandlers(store);

  return (
    <Stack gap="sm">
      <Controller
        graph={imageHub}
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
          graph={imageHub}
          name="model"
          render={({ value, meta, onChange }) => {
            const defaultModelId = meta?.defaultModelId;
            return (
              <>
                <ResourceSelectInput
                  value={value}
                  onChange={onChange}
                  label={
                    <ControllerLabel
                      label="Model"
                      info="Models are the resources you're generating with. Using a different base model can drastically alter the style and composition of images, while adding additional resources can change the characters, concepts and objects."
                    />
                  }
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
      </div>
      <Controller
        graph={imageHub}
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
        graph={imageHub}
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
        graph={imageHub}
        names={['model', 'resources', 'vae'] as const}
        render={({ values }) => (
          <ResourceAlerts model={values.model} resources={values.resources} vae={values.vae} />
        )}
      />
      <Controller
        graph={imageHub}
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
        graph={imageHub}
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
                info="Type out what you'd like to generate in the prompt, add aspects you'd like to avoid in the negative prompt."
                required={meta?.required}
              />
            }
            placeholder="Your prompt goes here..."
            error={error?.message}
          />
        )}
      />
      <Controller
        graph={imageHub}
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
        graph={imageHub}
        name="aspectRatio"
        render={({ value, meta, onChange }) => {
          const priorityOptions =
            meta && meta.options.length > 5
              ? meta.options.slice(1, 6).map((o) => o.value)
              : undefined;
          return (
            <AspectRatioInput
              value={value}
              onChange={onChange}
              label="Aspect Ratio"
              options={meta?.options ?? []}
              priorityOptions={priorityOptions}
              maxVisible={5}
            />
          );
        }}
      />
      <Controller
        graph={imageHub}
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
            options={meta?.options}
            presets={meta?.presets}
          />
        )}
      />
      <Controller
        graph={imageHub}
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
            options={meta?.options}
          />
        )}
      />
      <Controller
        graph={imageHub}
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
        graph={imageHub}
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
        graph={imageHub}
        name="clipSkip"
        render={({ value, meta, onChange }) =>
          meta ? (
            <SliderInput
              value={value}
              onChange={onChange}
              label="CLIP Skip"
              min={meta.min}
              max={meta.max}
              step={meta.step}
              warning={
                value <= 1
                  ? 'Low CLIP Skip values may not work well depending on the model'
                  : undefined
              }
            />
          ) : null
        }
      />
      <Controller
        graph={imageHub}
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
      <Controller
        graph={imageHub}
        name="controlNets"
        render={({ value, meta, onChange, error }) => (
          <ControlNetsInput value={value} onChange={onChange} meta={meta} error={error?.message} />
        )}
      />
      <Controller
        graph={imageHub}
        name="seed"
        render={({ value, onChange }) => (
          <SeedInput value={value} onChange={onChange} label="Seed" />
        )}
      />
      <Controller
        graph={imageHub}
        name="vae"
        render={({ value, meta, onChange }) => (
          <ResourceSelectInput
            value={value}
            onChange={onChange}
            label={
              <ControllerLabel
                label="VAE"
                info="These provide additional color and detail improvements."
              />
            }
            buttonLabel="Select VAE"
            modalTitle="Select VAE"
            options={meta?.options}
            allowRemove
          />
        )}
      />
      <Controller
        graph={imageHub}
        name="resolution"
        render={({ value, meta, onChange }) => (
          <div className="flex flex-col gap-1">
            <Input.Label>Resolution</Input.Label>
            <SegmentedControlWrapper
              value={value}
              onChange={(v) => onChange(v as typeof value)}
              data={(meta as { options: { label: string; value: string }[] }).options.map((o) => ({
                label: o.label,
                value: o.value,
              }))}
            />
          </div>
        )}
      />
      <Controller
        graph={imageHub}
        name="quality"
        render={({ value, meta, onChange }) => (
          <SelectInput value={value} onChange={onChange} label="Quality" options={meta.options} />
        )}
      />
      <Controller
        graph={imageHub}
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
      <Controller
        graph={imageHub}
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
      {/* nested record-less branch (qwen -> qwen3) — key doesn't reach
          GraphFieldName yet, so the generic form types this one */}
      <Controller<boolean | undefined, undefined>
        name="enablePromptExpansion"
        render={({ value, onChange }) => (
          <Switch
            size="xs"
            label="Enhance prompt"
            labelPosition="left"
            checked={!!value}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        )}
      />
      <Controller
        graph={imageHub}
        name="creativity"
        render={({ value, meta, onChange }) => (
          <div className="flex flex-col gap-1">
            <Input.Label>Creativity</Input.Label>
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
      <Controller
        graph={imageHub}
        name="styleReferences"
        render={({ value, meta, onChange, error }) => (
          <Krea2StyleReferencesInput
            value={value}
            onChange={onChange}
            meta={meta}
            error={error?.message}
          />
        )}
      />
      <Controller
        graph={imageHub}
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
      <Controller
        graph={imageHub}
        name="enhancedCompatibility"
        render={({ value, onChange }) => (
          <Checkbox
            checked={value}
            onChange={(e) => onChange(e.target.checked)}
            label="Enhanced Compatibility"
            description="We've updated our generation engine for better performance, but older prompts may look different. Turn this on to make new generations look more like your originals."
          />
        )}
      />
      <div className="flex gap-4">
        <Controller
          graph={imageHub}
          name="outputFormat"
          render={({ value, meta, onChange }) => (
            <OutputFormatInput
              value={value}
              onChange={onChange}
              options={[...(meta?.options ?? [])]}
              isMember={meta?.isMember}
            />
          )}
        />
        <Controller
          graph={imageHub}
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
    </Stack>
  );
}
