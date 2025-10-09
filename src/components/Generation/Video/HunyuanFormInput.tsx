import { Anchor, Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputResourceSelectMultipleStandalone } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultipleStandalone';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { InputNumberSlider, InputSegmentedControl, InputTextArea } from '~/libs/form';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';
import { hunyuanAspectRatios, hunyuanDuration } from '~/server/orchestrator/hunyuan/hunyuan.schema';
import { InputRequestPriority } from '~/components/Generation/Input/RequestPriority';
import { getGenerationBaseModelResourceOptions } from '~/shared/constants/base-model.constants';

export function HunyuanFormInput() {
  const form = useFormContext();
  // const sourceImage = form.watch('sourceImage');

  return (
    <>
      <InputResourceSelectMultipleStandalone
        name="resources"
        options={{ resources: getGenerationBaseModelResourceOptions('HyV1'), canGenerate: true }}
        buttonLabel="Add additional resource"
      />
      <InputPrompt
        required
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputAspectRatioColonDelimited
        name="aspectRatio"
        label="Aspect Ratio"
        options={hunyuanAspectRatios}
      />

      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={hunyuanDuration.map((value) => ({ label: `${value}s`, value }))}
        />
      </div>

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
        min={4}
        max={8}
        step={0.1}
        precision={1}
        reverse
      />
      <InputSeed name="seed" label="Seed" />
      <InputRequestPriority name="priority" label="Request Priority" modifier="multiplier" />
    </>
  );
}
