import { Anchor, Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { InputNumberSlider, InputSegmentedControl, InputTextArea } from '~/libs/form';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';
import {
  lightricksAspectRatios,
  lightricksDuration,
} from '~/server/orchestrator/lightricks/lightricks.schema';
import { InputRequestPriority } from '~/components/Generation/Input/RequestPriority';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';

export function LightricksFormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const isTxt2Img = process === 'txt2vid';

  return (
    <>
      <InputVideoProcess name="process" />
      {process === 'img2vid' && (
        <InputSourceImageUpload name="sourceImage" className="flex-1" warnOnMissingAiMetadata />
      )}
      <InputPrompt
        required={isTxt2Img}
        name="prompt"
        minRows={2}
        description={
          <span>
            If you see poor results, please refer to the{' '}
            <Anchor
              href="https://education.civitai.com/civitais-quickstart-guide-to-lightricks-ltxv/#prompting"
              target="_blank"
            >
              prompt guide
            </Anchor>
          </span>
        }
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      {isTxt2Img && (
        <InputAspectRatioColonDelimited
          name="aspectRatio"
          label="Aspect Ratio"
          options={lightricksAspectRatios}
        />
      )}
      {/* <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={lightricksDuration.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div> */}
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
        min={3}
        max={3.5}
        step={0.1}
        precision={1}
        reverse
      />
      <InputNumberSlider
        name="steps"
        label={
          <div className="flex items-center gap-1">
            <Input.Label>Steps</Input.Label>
            <InfoPopover size="xs" iconProps={{ size: 14 }}>
              The number of iterations spent generating a video.
            </InfoPopover>
          </div>
        }
        min={20}
        max={40}
        reverse
      />
      <InputSeed name="seed" label="Seed" />
      <InputRequestPriority name="priority" label="Request Priority" modifier="multiplier" />
    </>
  );
}
