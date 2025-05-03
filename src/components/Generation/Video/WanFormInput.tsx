import { Anchor, Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputResourceSelectMultipleStandalone } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultipleStandalone';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { InputNumberSlider, InputSegmentedControl, InputTextArea } from '~/libs/form';
import { wanAspectRatios, wanDuration } from '~/server/orchestrator/wan/wan.schema';
import { baseModelResourceTypes } from '~/shared/constants/generation.constants';

export function WanFormInput() {
  const form = useFormContext();
  const sourceImage = form.watch('sourceImage');

  return (
    <>
      <InputSourceImageUpload name="sourceImage" label="Image (optional)" className="flex-1" />
      <InputResourceSelectMultipleStandalone
        name="resources"
        options={{ resources: baseModelResourceTypes.WanVideo }}
        buttonLabel="Add additional resource"
      />
      <InputTextArea name="prompt" label="Prompt" placeholder="Your prompt goes here..." autosize />
      {!sourceImage && (
        <InputAspectRatioColonDelimited
          name="aspectRatio"
          label="Aspect Ratio"
          options={wanAspectRatios}
        />
      )}
      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={wanDuration.map((value) => ({ label: `${value}s`, value }))}
        />
      </div>
      <InputNumberSlider
        name="cfgScale"
        label={
          <div className="flex items-center gap-1">
            <Input.Label>CFG Scale</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              Controls how closely the video generation follows the text prompt.{' '}
              <Anchor
                href="https://wiki.civitai.com/wiki/Classifier_Free_Guidance"
                target="_blank"
                rel="nofollow noreferrer"
                span
              >
                Learn more
              </Anchor>
              .
            </InfoPopover>
          </div>
        }
        min={2}
        max={6}
        step={0.1}
        precision={1}
        reverse
      />
      <InputSeed name="seed" label="Seed" />
    </>
  );
}
