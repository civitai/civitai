import { useFormContext } from 'react-hook-form';
import { Input } from '@mantine/core';
import { InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import { viduDuration } from '~/server/orchestrator/vidu/vidu.schema';
import { ViduVideoGenStyle } from '@civitai/client';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { IconPlus } from '@tabler/icons-react';

export function ViduFormInput() {
  const form = useFormContext();
  const sourceImage = form.watch('sourceImage');
  const endSourceImage = form.watch('endSourceImage');
  const hasImage = !!sourceImage || !!endSourceImage;

  return (
    <>
      <div className="flex flex-col">
        <div className="flex justify-center gap-2">
          <InputSourceImageUpload
            name="sourceImage"
            className="flex aspect-video flex-1 flex-col justify-center"
            iconSize={32}
          >
            <div className="flex flex-col items-center gap-2">
              <span className="text-sm">Upload image</span>
            </div>
          </InputSourceImageUpload>
          <InputSourceImageUpload
            name="endSourceImage"
            className="flex aspect-video flex-1 flex-col justify-center"
            iconSize={32}
          >
            <div className="flex flex-col items-center gap-2">
              <span className="text-sm">(Optional)</span>
            </div>
          </InputSourceImageUpload>
        </div>
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
