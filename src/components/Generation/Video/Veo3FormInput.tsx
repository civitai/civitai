import { Radio } from '@headlessui/react';
import { Input, SegmentedControl } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import {
  getVeo3Checkpoint,
  getVeo3IsFastMode,
  removeVeo3CheckpointFromResources,
  veo3AspectRatios,
  veo3Duration,
  veo3ModelOptions,
  veo3Models,
  veo3StandardId,
} from '~/server/orchestrator/veo3/veo3.schema';
import clsx from 'clsx';
import type { ResourceInput } from '~/server/orchestrator/infrastructure/base.schema';
import {
  InputSourceImageUploadMultiple,
  SourceImageUploadMultiple,
} from '~/components/Generation/Input/SourceImageUploadMultiple';
import { useEffect } from 'react';

export function Veo3FormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const isTxt2Vid = process === 'txt2vid';
  const resources = form.watch('resources') as ResourceInput[] | null;
  const checkpoint = getVeo3Checkpoint(resources);
  const isFastMode = getVeo3IsFastMode(checkpoint.id);

  useEffect(() => {
    if (isFastMode) form.setValue('process', 'txt2vid');
  }, [isFastMode]);

  useEffect(() => {
    if (process === 'img2vid' && isFastMode) setCheckpoint(veo3StandardId);
  }, [process]);

  function setCheckpoint(modelVersionId: number) {
    const resourcesWithoutModel = removeVeo3CheckpointFromResources(resources);
    const checkpoint = veo3Models.find((x) => x.id === modelVersionId);
    if (checkpoint) form.setValue('resources', [checkpoint, ...resourcesWithoutModel]);
  }

  return (
    <>
      {/* <InputVideoProcess name="process" />
      {process === 'img2vid' && (
        <div className="-mx-2">
          <InputSourceImageUploadMultiple
            name="images"
            max={1}
            warnOnMissingAiMetadata
            aspect="video"
          >
            {(previewItems) => (
              <div className="mx-auto max-w-80">
                {previewItems.map((item, i) => (
                  <SourceImageUploadMultiple.Image key={i} index={i} {...item} />
                ))}
                <SourceImageUploadMultiple.Dropzone />
              </div>
            )}
          </InputSourceImageUploadMultiple>
        </div>
      )} */}
      <div className="flex flex-col gap-2">
        <Input.Label>Model</Input.Label>
        <SegmentedControl
          data={veo3ModelOptions}
          value={checkpoint.id.toString()}
          onChange={(value) => setCheckpoint(Number(value))}
        ></SegmentedControl>
      </div>
      <InputTextArea
        required={isTxt2Vid}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable Prompt Enhancer" />
      {isTxt2Vid && (
        <InputAspectRatioColonDelimited
          name="aspectRatio"
          label="Aspect Ratio"
          options={veo3AspectRatios}
        />
      )}

      {/* <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={veo3Duration.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div> */}
      <InputSwitch name="generateAudio" label="Generate Audio" />

      <InputSeed name="seed" label="Seed" />
    </>
  );
}
