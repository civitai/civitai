import { Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { HaiperAspectRatio } from '~/components/ImageGeneration/GenerationForm/HaiperAspectRatio';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import { haiperDuration } from '~/server/orchestrator/haiper/haiper.schema';

export function HaiperFormInput() {
  const form = useFormContext();
  const sourceImage = form.watch('sourceImage');

  return (
    <>
      <InputSourceImageUpload name="sourceImage" label="Image (optional)" className="flex-1" />
      <InputTextArea
        required={!sourceImage}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      {!sourceImage && <HaiperAspectRatio name="aspectRatio" label="Aspect Ratio" />}
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={haiperDuration.map((value) => ({ label: `${value}s`, value }))}
        />
      </div>
      <InputSeed name="seed" label="Seed" />
    </>
  );
}
