import { Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import { HaiperAspectRatio } from '~/components/ImageGeneration/GenerationForm/HaiperAspectRatio';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';
import { haiperDuration } from '~/server/orchestrator/haiper/haiper.schema';

export function HaiperFormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const isTxt2Vid = process === 'txt2vid';

  return (
    <>
      <InputVideoProcess name="process" />
      {process === 'img2vid' && (
        <InputSourceImageUpload name="sourceImage" className="flex-1" warnOnMissingAiMetadata />
      )}
      <InputPrompt
        required={isTxt2Vid}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputTextArea name="negativePrompt" label="Negative Prompt" autosize />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      {isTxt2Vid && <HaiperAspectRatio name="aspectRatio" label="Aspect Ratio" />}
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
