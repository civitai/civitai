import { Input } from '@mantine/core';
import { useFormContext } from 'react-hook-form';
import { InputAspectRatioColonDelimited } from '~/components/Generate/Input/InputAspectRatioColonDelimited';
import { InputVideoProcess } from '~/components/Generation/Input/VideoProcess';
import InputSeed from '~/components/ImageGeneration/GenerationForm/InputSeed';
import { InputSegmentedControl, InputSwitch } from '~/libs/form';
import {
  soraResolutions,
  soraAspectRatios,
  soraDurations,
} from '~/server/orchestrator/sora/sora.schema';
import {
  InputSourceImageUploadMultiple,
  SourceImageUploadMultiple,
} from '~/components/Generation/Input/SourceImageUploadMultiple';
import { InputPrompt } from '~/components/Generate/Input/InputPrompt';

export function SoraFormInput() {
  const form = useFormContext();
  const process = form.watch('process');
  const isTxt2Vid = process === 'txt2vid';

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
            aspectRatios={[...soraAspectRatios]}
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
      <InputPrompt
        required={isTxt2Vid}
        name="prompt"
        label="Prompt"
        placeholder="Your prompt goes here..."
        autosize
      />
      {isTxt2Vid ? (
        <>
          <InputAspectRatioColonDelimited
            name="aspectRatio"
            label="Aspect Ratio"
            options={soraAspectRatios}
          />
        </>
      ) : null}
      <div className="flex flex-col gap-0.5">
        <Input.Label>Resolution</Input.Label>
        <InputSegmentedControl name="resolution" data={soraResolutions} />
      </div>

      <div className="flex flex-col gap-0.5">
        <Input.Label>Duration</Input.Label>
        <InputSegmentedControl
          name="duration"
          data={soraDurations.map((value) => ({
            label: `${value}s`,
            value,
          }))}
        />
      </div>
      <InputSwitch name="usePro" label="Pro mode" />

      <InputSeed name="seed" label="Seed" />
    </>
  );
}
