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
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';

export function ViduFormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const sourceImage = form.watch('sourceImage');
  const endSourceImage = form.watch('endSourceImage');
  const model = form.watch('model');

  useEffect(() => {
    if (process === 'txt2vid') return;
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
      <InputVideoProcess name="process" />
      {process === 'img2vid' && (
        <div className="flex justify-center gap-2">
          <InputSourceImageUpload
            name="sourceImage"
            className="flex aspect-video flex-1 flex-col justify-start"
            iconSize={32}
          >
            <div className="flex flex-col items-center gap-2">
              <span className="text-sm">Starting image</span>
            </div>
          </InputSourceImageUpload>
          <InputSourceImageUpload
            name="endSourceImage"
            className="flex aspect-video flex-1 flex-col justify-start"
            iconSize={32}
          >
            <div className="flex flex-col items-center gap-2">
              <span className="text-sm">Ending image (optional)</span>
            </div>
          </InputSourceImageUpload>
        </div>
      )}
      <InputTextArea
        required={process === 'txt2vid'}
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
      {process === 'txt2vid' && (
        <div className="flex flex-col gap-0.5">
          <Input.Label>Style</Input.Label>
          <InputSegmentedControl
            name="style"
            data={[
              { label: 'General', value: ViduVideoGenStyle.GENERAL },
              { label: 'Animation', value: ViduVideoGenStyle.ANIME },
            ]}
          />
        </div>
      )}

      <InputSeed name="seed" label="Seed" />
    </>
  );
}
