import { Anchor, Input, Radio } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputResourceSelectMultipleStandalone } from '~/components/ImageGeneration/GenerationForm/ResourceSelectMultipleStandalone';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import {
  InputNumberSlider,
  InputRadioGroup,
  InputSegmentedControl,
  InputTextArea,
} from '~/libs/form';
import { wanAspectRatios, wanDuration, wanModelMap } from '~/server/orchestrator/wan/wan.schema';
import { baseModelResourceTypes } from '~/shared/constants/generation.constants';
import { InputRequestPriority } from '~/components/Generation/Input/RequestPriority';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import { useEffect, useMemo } from 'react';

export function WanFormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const model = form.getValues('model');
  const isTxt2Img = process === 'txt2vid';
  const availableModels = useMemo(
    () => wanModelMap[process as keyof typeof wanModelMap] ?? [],
    [process]
  );
  const resources = availableModels.find((x) => x.value === model)?.resources;

  useEffect(() => {
    const model = form.getValues('model');
    if (!availableModels.find((x) => x.value === model)) {
      const defaultModel = availableModels.find((x) => x.default) ?? availableModels[0];
      form.setValue('model', defaultModel.value);
    }
  }, [availableModels]);

  return (
    <>
      <InputVideoProcess name="process" />
      <InputRadioGroup label="Model" name="model">
        {availableModels.map(({ label, value }) => (
          <Radio key={value} label={label} value={value} />
        ))}
      </InputRadioGroup>
      {process === 'img2vid' && <InputSourceImageUpload name="sourceImage" className="flex-1" />}
      {!!resources?.length && (
        <InputResourceSelectMultipleStandalone
          name="resources"
          options={{ resources: [...resources, ...baseModelResourceTypes.WanVideo] }}
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
      <InputRequestPriority name="priority" label="Request Priority" modifier="multiplier" />
    </>
  );
}
