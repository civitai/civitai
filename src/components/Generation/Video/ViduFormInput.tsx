import { useFormContext } from 'react-hook-form';
import { Input } from '@mantine/core';
import { InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import { viduDuration } from '~/server/orchestrator/vidu/vidu.schema';
import { ViduVideoGenStyle } from '@civitai/client';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { useEffect } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ImageCropModal } from '~/components/Generation/Input/ImageCropModal';

export function ViduFormInput() {
  const form = useFormContext();
  const sourceImage = form.watch('sourceImage');
  const endSourceImage = form.watch('endSourceImage');
  const hasImage = !!sourceImage || !!endSourceImage;
  const model = form.watch('model');

  useEffect(() => {
    if (
      !sourceImage ||
      !endSourceImage ||
      sourceImage instanceof Blob ||
      endSourceImage instanceof Blob
    )
      return;
    const ar1 = sourceImage.width / sourceImage.height;
    const ar2 = endSourceImage.width / endSourceImage.height;
    if (Math.round(ar1 * 100) / 100 !== Math.round(ar2 * 100) / 100) {
      dialogStore.trigger({
        component: ImageCropModal,
        props: {
          images: [
            { ...sourceImage, label: 'First Frame' },
            { ...endSourceImage, label: 'Last Frame' },
          ],
          onConfirm: (urls) => {
            if (urls[0] instanceof Blob) form.setValue('sourceImage', urls[0]);
            if (urls[1] instanceof Blob) form.setValue('endSourceImage', urls[1]);
          },
          onCancel: () => {
            form.setValue('endSourceImage', null);
          },
        },
      });
    }
  }, [sourceImage, endSourceImage]);

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
      {model !== 'q1' && (
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
      )}
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
