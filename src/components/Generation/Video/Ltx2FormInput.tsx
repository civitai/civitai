import { Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';
import { InputRequestPriority } from '~/components/Generation/Input/RequestPriority';
import {
  InputSourceImageUploadMultiple,
  SourceImageUploadMultiple,
} from '~/components/Generation/Input/SourceImageUploadMultiple';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputResourceSelectMultipleStandalone } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultipleStandalone';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { InputNumberSlider, InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import {
  ltx2AspectRatios,
  ltx2Duration,
  ltx2ModelToVersionMap,
} from '~/server/orchestrator/lightricks/lightricks.schema';
import { getGenerationBaseModelResourceOptions } from '~/shared/constants/base-model.constants';

const modelVersionOptions = [
  { label: '19B Dev', value: ltx2ModelToVersionMap['19b-dev'] },
  { label: '19B Distilled', value: ltx2ModelToVersionMap['19b-distilled'] },
];

export function Ltx2FormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const modelVersionId = form.watch('modelVersionId');
  const isTxt2Vid = process === 'txt2vid';
  const isDistilled = modelVersionId === ltx2ModelToVersionMap['19b-distilled'];

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <Input.Label>Model Version</Input.Label>
        <InputSegmentedControl name="modelVersionId" data={modelVersionOptions} />
      </div>
      <InputResourceSelectMultipleStandalone
        name="resources"
        options={{
          resources: getGenerationBaseModelResourceOptions('LTXV2').filter(
            (x) => x.type !== 'Checkpoint'
          ),
          canGenerate: true,
        }}
        buttonLabel="Add LoRA"
      />
      <InputVideoProcess name="process" />
      {process === 'img2vid' && (
        <div className="-mx-2">
          <InputSourceImageUploadMultiple
            name="images"
            max={1}
            warnOnMissingAiMetadata
            aspect="video"
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
      <InputPrompt
        required={isTxt2Vid}
        name="prompt"
        minRows={2}
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputTextArea
        name="negativePrompt"
        label="Negative Prompt"
        placeholder="What to avoid..."
        autosize
        minRows={1}
      />
      <InputAspectRatioColonDelimited
        name="aspectRatio"
        label="Aspect Ratio"
        options={ltx2AspectRatios}
      />
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={ltx2Duration.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div>
      {!isDistilled && (
        <>
          <InputNumberSlider
            name="cfgScale"
            label={
              <div className="flex items-center gap-1">
                <Input.Label>CFG Scale</Input.Label>
                <InfoPopover size="xs" iconProps={{ size: 14 }}>
                  Controls how closely the video generation follows the text prompt.
                </InfoPopover>
              </div>
            }
            min={1}
            max={10}
            step={0.5}
            precision={1}
            reverse
          />
          <InputNumberSlider
            name="steps"
            label={
              <div className="flex items-center gap-1">
                <Input.Label>Steps</Input.Label>
                <InfoPopover size="xs" iconProps={{ size: 14 }}>
                  The number of iterations spent generating a video.
                </InfoPopover>
              </div>
            }
            min={1}
            max={50}
            reverse
          />
        </>
      )}
      <InputSwitch name="generateAudio" label="Generate Audio" />
      <InputSeed name="seed" label="Seed" />
      <InputRequestPriority name="priority" label="Request Priority" modifier="multiplier" />
    </>
  );
}
