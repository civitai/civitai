import { Checkbox, Input, Stack, Textarea } from '@mantine/core';
import { AccordionLayout } from '~/components/generation_v2/AccordionLayout';
import { Controller } from 'form-graph/react';

import { GenerationTextEditor } from '~/components/Generate/Input/GenerationTextEditor';
import { ImageUploadMultipleInput } from '~/components/generation_v2/inputs/ImageUploadMultipleInput';
import { ResourceSelectInput } from '~/components/generation_v2/inputs/ResourceSelectInput';
import { SeedInput } from '~/components/generation_v2/inputs/SeedInput';
import { SliderInput } from '~/components/generation_v2/inputs/SliderInput';
import { SegmentedControlWrapper } from '~/libs/form/components/SegmentedControlWrapper';
import { audioHub } from '~/shared/form-graph/generation/audio/hub.graph';

import { ControllerLabel, VersionGroupSelector } from './form-helpers';

/**
 * The AUDIO generation form — one `<Controller graph={audioHub}>` per field.
 * The graph decides visibility (simple vs custom mode, Ace vs MiniMax), so
 * this holds the superset of audio fields. `title` exists in the Ace graph
 * but has no control, matching v1.
 */

export function AudioGenerationForm() {
  return (
    <Stack gap="sm">
      <Controller
        graph={audioHub}
        name="model"
        render={({ value, meta, onChange }) => (
          <>
            <ResourceSelectInput
              value={value}
              onChange={onChange}
              label={<ControllerLabel label="Model" />}
              buttonLabel="Select Model"
              modalTitle="Select Model"
              options={meta?.options}
              allowRemove={false}
            />
            {meta?.versions ? (
              <VersionGroupSelector
                versions={meta.versions}
                modelId={value?.id}
                onChange={onChange}
              />
            ) : null}
          </>
        )}
      />
      <Controller
        graph={audioHub}
        name="generateCover"
        render={({ value, onChange }) => (
          <Checkbox
            label="Generate cover image"
            description="Auto-generate an album cover using AI"
            checked={value}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
        )}
      />
      <Controller
        graph={audioHub}
        name="images"
        render={({ value, meta, onChange, error }) => (
          <ImageUploadMultipleInput
            label="Cover image"
            value={value}
            onChange={onChange}
            max={meta?.max}
            aspectRatios={meta?.aspectRatios as `${number}:${number}`[] | undefined}
            error={error?.message}
          />
        )}
      />
      <Controller
        graph={audioHub}
        name="aceAudioMode"
        render={({ value, meta, onChange }) => (
          <div className="flex flex-col gap-1">
            <Input.Label>Mode</Input.Label>
            <SegmentedControlWrapper
              value={value}
              onChange={(v) => onChange(v as typeof value)}
              data={meta?.options?.map((o) => ({ label: o.label, value: o.value })) ?? []}
            />
          </div>
        )}
      />
      <Controller
        graph={audioHub}
        name="minimaxMusicMode"
        render={({ value, meta, onChange }) => (
          <div className="flex flex-col gap-1">
            <Input.Label>Mode</Input.Label>
            <SegmentedControlWrapper
              value={value}
              onChange={(v) => onChange(v as typeof value)}
              data={meta?.options?.map((o) => ({ label: o.label, value: o.value })) ?? []}
            />
          </div>
        )}
      />
      <Controller
        graph={audioHub}
        name="prompt"
        render={({ value, meta, onChange, error }) => (
          <GenerationTextEditor
            value={value}
            onChange={onChange}
            triggerWords={meta?.triggerWords}
            label={
              <ControllerLabel
                label="Prompt"
                info="Describe the song concept in plain English — a chat model drafts the lyrics, music description, BPM, and key from it."
                required={meta?.required}
              />
            }
            placeholder="Describe the song you want to generate..."
            error={error?.message}
          />
        )}
      />
      <Controller
        graph={audioHub}
        name="musicDescription"
        render={({ value, onChange, error }) => (
          <Textarea
            label="Music Description"
            description="Describe the music style, genre, mood, and instruments"
            placeholder="Neo-Soul: A warm, organic neo-soul track with smooth Rhodes chords..."
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            error={error?.message}
            autosize
            minRows={2}
          />
        )}
      />
      <Controller
        graph={audioHub}
        name="lyrics"
        render={({ value, onChange, error }) => (
          <Textarea
            label="Lyrics"
            description="Structured lyrics with section markers like [Verse], [Chorus], [Bridge]"
            placeholder={
              "[Verse]\nBreaking through the walls tonight\nNothing's gonna stop this fight\n\n[Chorus]\nRock and roll forever\nWe're in this together"
            }
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            error={error?.message}
            autosize
            minRows={4}
          />
        )}
      />
      <Controller
        graph={audioHub}
        name="bpm"
        render={({ value, meta, onChange }) => (
          <SliderInput
            label="BPM"
            value={value}
            onChange={onChange}
            min={meta?.min ?? 40}
            max={meta?.max ?? 200}
          />
        )}
      />
      <Controller
        graph={audioHub}
        name="instrumentalWeight"
        render={({ value, meta, onChange }) => (
          <SliderInput
            label="Instrumental Weight"
            value={value}
            onChange={onChange}
            min={meta?.min ?? 0}
            max={meta?.max ?? 1}
            step={meta?.step ?? 0.1}
            precision={1}
          />
        )}
      />
      <Controller
        graph={audioHub}
        name="vocalWeight"
        render={({ value, meta, onChange }) => (
          <SliderInput
            label="Vocal Weight"
            value={value}
            onChange={onChange}
            min={meta?.min ?? 0}
            max={meta?.max ?? 1}
            step={meta?.step ?? 0.1}
            precision={1}
          />
        )}
      />
      <Controller
        graph={audioHub}
        name="duration"
        render={({ value, meta, onChange }) => (
          <SliderInput
            label="Duration (seconds)"
            value={value}
            onChange={onChange}
            min={meta?.min ?? 1}
            max={meta?.max ?? 300}
            step={meta && 'step' in meta ? meta.step : 1}
          />
        )}
      />
      <AccordionLayout label="Advanced" storeKey="form-graph-audio-advanced">
        <Controller
          graph={audioHub}
          name="cfgScale"
          render={({ value, meta, onChange }) => (
            <SliderInput
              label="CFG Scale"
              value={value}
              onChange={onChange}
              min={meta?.min ?? 0.5}
              max={meta?.max ?? 10}
              step={meta?.step ?? 0.5}
            />
          )}
        />
        <Controller
          graph={audioHub}
          name="steps"
          render={({ value, meta, onChange }) => (
            <SliderInput
              label="Steps"
              value={value}
              onChange={onChange}
              min={meta?.min ?? 1}
              max={meta?.max ?? 100}
              step={meta?.step ?? 1}
            />
          )}
        />
        <Controller
          graph={audioHub}
          name="seed"
          render={({ value, onChange }) => (
            <SeedInput value={value} onChange={onChange} label="Seed" />
          )}
        />
      </AccordionLayout>
    </Stack>
  );
}
