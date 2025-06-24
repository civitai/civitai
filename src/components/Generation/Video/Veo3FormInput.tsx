import { Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import { veo3AspectRatios, veo3Duration } from '~/server/orchestrator/veo3/veo3.schema';

export function Veo3FormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const isTxt2Vid = process === 'txt2vid';

  return (
    <>
      {/* <InputVideoProcess name="process" />
      {process === 'img2vid' && (
        <InputSourceImageUpload name="sourceImage" warnOnMissingAiMetadata />
      )} */}
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
