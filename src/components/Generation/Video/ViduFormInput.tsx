import { useFormContext } from 'react-hook-form';
import { Input, Radio } from '@mantine/core';
import { InputRadioGroup, InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import {
  viduAspectRatios,
  viduDurations,
  viduMovementAmplitudes,
} from '~/server/orchestrator/vidu/vidu.schema';
import { ViduVideoGenStyle } from '@civitai/client';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { useEffect } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ImageCropModal } from '~/components/Generation/Input/ImageCropModal';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';

export function ViduFormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const sourceImage = form.watch('sourceImage');
  const endSourceImage = form.watch('endSourceImage');
  const model = form.watch('model');
  const isTxt2Vid = process === 'txt2vid';

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
              <span className="text-center text-sm">Starting image</span>
            </div>
          </InputSourceImageUpload>
          <InputSourceImageUpload
            name="endSourceImage"
            className="flex aspect-video flex-1 flex-col justify-start"
            iconSize={32}
          >
            <div className="flex flex-col items-center gap-2">
              <span className="text-center text-sm">Ending image (optional)</span>
            </div>
          </InputSourceImageUpload>
        </div>
      )}
      <InputTextArea
        required={isTxt2Vid}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      {model === 'q1' && isTxt2Vid && (
        <InputAspectRatioColonDelimited
          name="aspectRatio"
          label="Aspect Ratio"
          options={viduAspectRatios}
        />
      )}
      {model !== 'q1' && (
        <div className="flex flex-col gap-0.5">
          <Input.Label>Duration</Input.Label>
          <InputSegmentedControl
            name="duration"
            data={viduDurations.map((value) => ({
              label: `${value}s`,
              value,
            }))}
          />
        </div>
      )}
      {isTxt2Vid && (
        // <div className="flex flex-col gap-0.5">
        //   <Input.Label>Style</Input.Label>
        //   <InputSegmentedControl
        //     name="style"
        //     data={[
        //       { label: 'General', value: ViduVideoGenStyle.GENERAL },
        //       { label: 'Animation', value: ViduVideoGenStyle.ANIME },
        //     ]}
        //   />
        // </div>
        <InputRadioGroup name="style" label="Style" offset={4}>
          {[
            { label: 'General', value: ViduVideoGenStyle.GENERAL },
            { label: 'Animation', value: ViduVideoGenStyle.ANIME },
          ].map(({ label, value }) => (
            <Radio key={value} value={value} label={label} />
          ))}
        </InputRadioGroup>
      )}

      <InputRadioGroup name="movementAmplitude" label="Movement amplitude" offset={4}>
        {viduMovementAmplitudes.map((option) => (
          <Radio key={option} value={option} label={option} />
        ))}
      </InputRadioGroup>

      <InputSeed name="seed" label="Seed" />
    </>
  );
}
