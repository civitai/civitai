import { Anchor, Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputResourceSelectMultipleStandalone } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultipleStandalone';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { InputNumberSlider, InputSegmentedControl, InputSwitch, InputTextArea } from '~/libs/form';
import { wan22AspectRatios, wan22Resolutions } from '~/server/orchestrator/wan/wan.schema';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import type { BaseModelGroup } from '~/shared/constants/base-model.constants';
import { getGenerationBaseModelResourceOptions } from '~/shared/constants/base-model.constants';
import {
  InputSourceImageUploadMultiple,
  SourceImageUploadMultiple,
} from '~/components/Generation/Input/SourceImageUploadMultiple';

export function Wan22FormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  // const baseModel = form.watch('baseModel');
  const isTxt2Img = process === 'txt2vid';

  const baseModelGroup: BaseModelGroup =
    process === 'txt2vid' ? 'WanVideo-22-T2V-A14B' : 'WanVideo-22-I2V-A14B';
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
      {!!resources?.length && (
        <InputResourceSelectMultipleStandalone
          name="resources"
          options={{
            resources: resources.filter((x) => x.type !== 'Checkpoint'),
            canGenerate: true,
          }}
          buttonLabel="Add additional resource"
        />
      )}
      <InputTextArea
        required={isTxt2Img}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
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
        <InputSegmentedControl name="resolution" data={[...wan22Resolutions]} />
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
        min={1}
        max={10}
        step={0.1}
        precision={1}
        reverse
      />
      <InputSwitch name="turbo" label="Turbo" />
      <InputSeed name="seed" label="Seed" />
    </>
  );
}
