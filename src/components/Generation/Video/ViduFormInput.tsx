import { useFormContext } from 'react-hook-form';
import { Group, Input, Radio, Text } from '@mantine/core';
import { InputRadioGroup, InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';
import {
  viduAspectRatios,
  viduDurations,
  viduMovementAmplitudes,
} from '~/server/orchestrator/vidu/vidu.schema';
import { ViduVideoGenStyle } from '@civitai/client';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { useEffect, useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { ImageCropModal } from '~/components/Generation/Input/ImageCropModal';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { titleCase } from '~/utils/string-helpers';
import {
  InputSourceImageUploadMultiple,
  SourceImageUploadMultiple,
} from '~/components/Generation/Input/SourceImageUploadMultiple';

export function ViduFormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const sourceImage = form.watch('sourceImage');
  const endSourceImage = form.watch('endSourceImage');
  const model = form.watch('model');
  const isTxt2Vid = process === 'txt2vid';
  const isRef2Vid = process === 'ref2vid';

  const [Warning1, setWarning1] = useState<JSX.Element | null>(null);
  const [Warning2, setWarning2] = useState<JSX.Element | null>(null);

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
            if (urls[0].cropped) form.setValue('sourceImage', urls[0].cropped ?? urls[0].src);
            if (urls[1].cropped) form.setValue('endSourceImage', urls[1].cropped ?? urls[1].src);
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
      <InputSegmentedControl
        size="sm"
        name="process"
        color="blue"
        data={[
          { label: 'Text to Video', value: 'txt2vid' },
          { label: 'Image to Video', value: 'img2vid' },
          { label: 'Reference to Video', value: 'ref2vid' },
        ]}
        classNames={{ label: '@max-xs:text-xs' }}
      />
      {process === 'ref2vid' && (
        <div className="-mx-2">
          <InputSourceImageUploadMultiple name="images" max={7} warnOnMissingAiMetadata>
            {(previewItems) => (
              <div className="grid grid-cols-2 gap-4 @xs:grid-cols-3 @sm:grid-cols-4">
                {previewItems.map((item, i) => (
                  <SourceImageUploadMultiple.Image key={i} index={i} {...item} />
                ))}
                <SourceImageUploadMultiple.Dropzone />
              </div>
            )}
          </InputSourceImageUploadMultiple>
        </div>
      )}
      {process === 'img2vid' && (
        <div className="flex flex-col gap-2">
          <div className="flex justify-center gap-2">
            <InputSourceImageUpload
              name="sourceImage"
              className="flex  flex-1 flex-col justify-start"
              iconSize={32}
              onWarnMissingAiMetadata={setWarning1}
            >
              <div className="flex flex-col items-center gap-2">
                <span className="text-center text-sm">Starting image</span>
              </div>
            </InputSourceImageUpload>
            <InputSourceImageUpload
              name="endSourceImage"
              className="flex flex-1 flex-col justify-start"
              iconSize={32}
              onWarnMissingAiMetadata={setWarning2}
            >
              <div className="flex flex-col items-center gap-2">
                <span className="text-center text-sm">Ending image (optional)</span>
              </div>
            </InputSourceImageUpload>
          </div>
          {Warning1 ?? Warning2}
        </div>
      )}
      <InputPrompt
        required={isTxt2Vid}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputSwitch name="enablePromptEnhancer" label="Enable prompt enhancer" />
      {model === 'q1' && (isTxt2Vid || isRef2Vid) && (
        <InputAspectRatioColonDelimited
          name="aspectRatio"
          label="Aspect Ratio"
          options={viduAspectRatios}
        />
      )}
      {/* {model !== 'q1' && (
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
      )} */}
      {isTxt2Vid && (
        <InputRadioGroup name="style" label="Style">
          <Group gap="lg">
            {[
              { label: 'General', value: ViduVideoGenStyle.GENERAL },
              { label: 'Animation', value: ViduVideoGenStyle.ANIME },
            ].map(({ label, value }) => (
              <Radio key={value} value={value} label={label} />
            ))}
          </Group>
        </InputRadioGroup>
      )}

      <InputRadioGroup
        name="movementAmplitude"
        label={
          <div className="flex gap-1">
            <span>Movement Amplitude</span>
            <InfoPopover size="sm" withArrow iconProps={{ size: 16 }} width={420}>
              <div className="flex flex-col">
                <Text>Control the scale of camera movements and subject actions.</Text>
                <Text>Default: Auto (fits most use cases)</Text>
              </div>
            </InfoPopover>
          </div>
        }
      >
        <Group gap="lg">
          {viduMovementAmplitudes.map((option) => (
            <Radio key={option} value={option} label={titleCase(option)} />
          ))}
        </Group>
      </InputRadioGroup>

      <InputSeed name="seed" label="Seed" />
    </>
  );
}
