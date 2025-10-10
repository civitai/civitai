import { KlingMode, KlingModel } from '@civitai/client';
import { Anchor, Input, Radio } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import {
  InputNumberSlider,
  InputRadioGroup,
  InputSegmentedControl,
  InputSelect,
  InputTextArea,
} from '~/libs/form';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';
import {
  klingAspectRatios,
  klingDuration,
  klingModels,
} from '~/server/orchestrator/kling/kling.schema';

export function KlingFormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const isTxt2Vid = process === 'txt2vid';
  const model = form.watch('model');

  return (
    <>
      <InputVideoProcess name="process" />
      <InputRadioGroup name="model" label="Version">
        <div className="flex flex-wrap gap-3">
          {klingModels.map((value) => (
            <Radio key={value} value={value} label={value.toLowerCase().replace('_', '.')} />
          ))}
        </div>
      </InputRadioGroup>
      {process === 'img2vid' && (
        <InputSourceImageUpload name="sourceImage" warnOnMissingAiMetadata />
      )}
      <InputPrompt
        required={isTxt2Vid}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      {isTxt2Vid && (
        <InputAspectRatioColonDelimited
          name="aspectRatio"
          label="Aspect Ratio"
          options={klingAspectRatios}
        />
      )}

      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={klingDuration.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div>
      {model === KlingModel.V1_6 && (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-1">
            <Input.Label>Mode</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              Standard mode is faster to generate and more cost-effective. Pro takes longer to
              generate and has higher quality video output.
            </InfoPopover>
          </div>
          <InputSegmentedControl
            name="mode"
            data={[
              { label: 'Standard', value: KlingMode.STANDARD },
              { label: 'Professional', value: KlingMode.PROFESSIONAL },
            ]}
          />
        </div>
      )}
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
        min={0.1}
        max={1}
        step={0.1}
        precision={1}
        reverse
      />
    </>
  );
}
