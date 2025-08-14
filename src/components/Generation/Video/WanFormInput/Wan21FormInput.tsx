import { Anchor, Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputResourceSelectMultipleStandalone } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultipleStandalone';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { InputNumberSlider, InputSegmentedControl, InputTextArea } from '~/libs/form';
import { wanDuration, wan22BaseModelMap } from '~/server/orchestrator/wan/wan.schema';
import { InputRequestPriority } from '~/components/Generation/Input/RequestPriority';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import { useEffect, useMemo } from 'react';
import { getGenerationBaseModelResourceOptions } from '~/shared/constants/base-model.constants';
import {
  InputSourceImageUploadMultiple,
  SourceImageUploadMultiple,
} from '~/components/Generation/Input/SourceImageUploadMultiple';

export function Wan21FormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const baseModel = form.watch('baseModel');
  const isTxt2Img = process === 'txt2vid';
  const config = wan22BaseModelMap[baseModel as keyof typeof wan22BaseModelMap];
  const canPickDuration = config?.provider !== 'fal';

  const availableBaseModels = useMemo(
    () =>
      Object.entries(wan22BaseModelMap)
        .filter(([key, value]) => value.process === process)
        .map(([key, value]) => ({
          value: key,
          label: value.resolution,
          default: value.default,
          provider: value.provider,
        })),
    [process]
  );

  useEffect(() => {
    if (!availableBaseModels.find((x) => x.value === baseModel)) {
      const defaultModel = availableBaseModels.find((x) => x.default) ?? availableBaseModels[0];
      if (defaultModel) {
        form.setValue('baseModel', defaultModel.value);
      }
    }
  }, [availableBaseModels, baseModel]);

  useEffect(() => {
    if (config?.provider === 'fal') form.setValue('duration', 5);
  }, [config?.provider]);

  const resources = getGenerationBaseModelResourceOptions(baseModel) ?? [];

  return (
    <>
      <InputVideoProcess name="process" />

      {/* {availableBaseModels.length > 1 && (
        <InputRadioGroup label="Resolution" name="baseModel">
          <Group gap="lg">
            {availableBaseModels.map(({ label, value }) => (
              <Radio key={value} label={label} value={value} />
            ))}
          </Group>
        </InputRadioGroup>
      )} */}

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
          options={config.aspectRatios}
        />
      )}
      {availableBaseModels.length > 1 && (
        <div className="flex flex-col gap-0.5">
          <Input.Label>Resolution</Input.Label>
          <InputSegmentedControl
            name="baseModel"
            data={availableBaseModels.map(({ label, value }) => ({ label, value }))}
          />
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          disabled={!canPickDuration}
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
      <InputRequestPriority name="priority" label="Request Priority" modifier="multiplier" />
    </>
  );
}
