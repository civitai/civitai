import { Anchor, Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputResourceSelectMultipleStandalone } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultipleStandalone';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { InputNumberSlider, InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';
import {
  maxFalAdditionalResources,
  wan22AspectRatios,
  wan25Duration,
  wan25Resolutions,
} from '~/server/orchestrator/wan/wan.schema';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import type { BaseModelGroup } from '~/shared/constants/base-model.constants';
import { getGenerationBaseModelResourceOptions } from '~/shared/constants/base-model.constants';
import {
  InputSourceImageUploadMultiple,
  SourceImageUploadMultiple,
} from '~/components/Generation/Input/SourceImageUploadMultiple';

export function Wan25FormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  // const baseModel = form.watch('baseModel');
  const isTxt2Img = process === 'txt2vid';

  const baseModelGroup: BaseModelGroup =
    process === 'txt2vid' ? 'WanVideo-25-T2V' : 'WanVideo-25-I2V';
  const resources = getGenerationBaseModelResourceOptions(baseModelGroup);

  return (
    <>
      <InputVideoProcess name="process" />
      {process === 'img2vid' && (
        <div className="-mx-2">
          <InputSourceImageUploadMultiple
            name="images"
            max={1}
            warnOnMissingAiMetadata
            aspect="video"
          >
            {(previewItems) => (
              <div className="mx-auto w-full max-w-80">
                {previewItems.map((item, i) => (
                  <SourceImageUploadMultiple.Image key={i} index={i} {...item} />
                ))}
                <SourceImageUploadMultiple.Dropzone />
              </div>
            )}
          </InputSourceImageUploadMultiple>
        </div>
      )}
      {/* {!!resources?.length && (
        <InputResourceSelectMultipleStandalone
          name="resources"
          options={{
            resources: resources.filter((x) => x.type !== 'Checkpoint'),
            canGenerate: true,
          }}
          buttonLabel="Add additional resource"
          limit={maxFalAdditionalResources}
        />
      )} */}
      <InputPrompt
        required
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      <InputTextArea
        name="negativePrompt"
        label="Negative Prompt"
        placeholder="Your negative prompt goes here..."
        autosize
      />
      {isTxt2Img && (
        <InputAspectRatioColonDelimited
          name="aspectRatio"
          label="Aspect Ratio"
          options={wan22AspectRatios}
        />
      )}

      <div className="flex flex-col gap-0.5">
        <Input.Label>Resolution</Input.Label>
        <InputSegmentedControl name="resolution" data={[...wan25Resolutions]} />
      </div>

      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={wan25Duration.map((value) => ({ label: `${value}s`, value }))}
        />
      </div>

      <InputNumberSlider
        name="cfgScale"
        label={
          <div className="flex items-center gap-1">
            <Input.Label>CFG Scale</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              Controls how closely the video generation follows the text prompt.
            </InfoPopover>
          </div>
        }
        min={1}
        max={10}
        step={0.1}
        precision={1}
      />

      <InputSeed name="seed" label="Seed" />
    </>
  );
}
