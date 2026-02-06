import { Input, Radio, SegmentedControl, Select } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputRadioGroup, InputSelect, InputSwitch, InputTextArea } from '~/libs/form';
import {
  getVeo3Checkpoint,
  veo3ModelOptions,
  getVeo3Models,
  removeVeo3CheckpointFromResources,
  veo3AspectRatios,
  veo3Durations,
  veo3Versions,
} from '~/server/orchestrator/veo3/veo3.schema';
import type { ResourceInput } from '~/server/orchestrator/infrastructure/base.schema';
import {
  InputSourceImageUploadMultiple,
  SourceImageUploadMultiple,
} from '~/components/Generation/Input/SourceImageUploadMultiple';
import { useEffect, useMemo } from 'react';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';

export function Veo3FormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const isTxt2Vid = process === 'txt2vid';
  const resources = form.watch('resources') as ResourceInput[] | null;
  const checkpoint = getVeo3Checkpoint(resources);

  function setCheckpoint(air: string) {
    const resourcesWithoutModel = removeVeo3CheckpointFromResources(resources);
    const checkpoint = getVeo3Models().find((x) => x.air === air);
    if (checkpoint) form.setValue('resources', [checkpoint, ...resourcesWithoutModel]);
  }

  const availableModelOptions = useMemo(
    () => veo3ModelOptions.filter((x) => x.process === process),
    [process]
  );

  useEffect(() => {
    const exists = availableModelOptions.some((x) => x.value === checkpoint.air);
    if (!exists) setCheckpoint(availableModelOptions[0].value);
  }, [availableModelOptions, checkpoint]);

  return (
    <>
      <InputVideoProcess name="process" />
      <InputRadioGroup name="version" label="Version">
        <div className="flex flex-wrap gap-3">
          {veo3Versions.map((value) => (
            <Radio key={value} value={value} label={value} />
          ))}
        </div>
      </InputRadioGroup>
      {process === 'img2vid' && (
        <div className="-mx-2">
          <InputSourceImageUploadMultiple
            name="images"
            max={1}
            warnOnMissingAiMetadata
            aspect="video"
            aspectRatios={['16:9', '9:16']}
          >
            {(previewItems) => (
              <div className="mx-auto w-full max-w-80">
                {previewItems.map((item, i) => (
                  <SourceImageUploadMultiple.Image key={i} index={i} {...item} />
                ))}
                <SourceImageUploadMultiple.Dropzone />
              </div>
            )}
          </InputSourceImageUploadMultiple>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Input.Label>Model</Input.Label>
        <SegmentedControl
          data={availableModelOptions}
          value={checkpoint.air}
          onChange={(air) => setCheckpoint(air)}
        ></SegmentedControl>
      </div>
      <InputPrompt
        required={isTxt2Vid}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable Prompt Enhancer" />
      {isTxt2Vid ? (
        <>
          <InputAspectRatioColonDelimited
            name="aspectRatio"
            label="Aspect Ratio"
            options={veo3AspectRatios}
          />
          <InputSelect
            name="duration"
            data={veo3Durations.map((value) => ({ label: `${value}s`, value }))}
            label="Duration"
          />
        </>
      ) : (
        <>
          <Select label="Duration" value={'8s'} data={['8s']} />
        </>
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
