import { useFormContext } from 'react-hook-form';
import { Input } from '@mantine/core';
import { InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import { viduDuration } from '~/server/orchestrator/vidu/vidu.schema';
import { ViduVideoGenStyle } from '@civitai/client';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';

export function ViduFormInput() {
  const form = useFormContext();
  const sourceImage = form.watch('sourceImage');
  const endSourceImage = form.watch('endSourceImage');
  const hasImage = !!sourceImage || !!endSourceImage;

  return (
    <>
      <div className="flex gap-2">
        <InputSourceImageUpload
          name="sourceImage"
          label="Start Image (optional)"
          className="flex-1"
        />
        <InputSourceImageUpload
          name="endSourceImage"
          label="End Image (optional)"
          className="flex-1"
        />
      </div>
      <InputTextArea
        required={!hasImage}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={viduDuration.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div>
      {!hasImage && (
        <div className="flex flex-col gap-0.5">
          <Input.Label>Style</Input.Label>
          <InputSegmentedControl
            name="style"
            data={Object.values(ViduVideoGenStyle).map((value) => ({
              label: value,
              value,
            }))}
          />
        </div>
      )}

      <InputSeed name="seed" label="Seed" />
    </>
  );
}
