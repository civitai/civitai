import { Modal } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { Form, InputNumberSlider, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import {
  SourceImageProps,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { useGenerate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { z } from 'zod';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';

const schema = z.object({
  sourceImage: sourceImageSchema,
  steps: z.number().min(0).max(3).catch(2),
});

export function UpscaleEnhancementModal({
  workflow,
  sourceImage,
}: {
  workflow: string;
  sourceImage: SourceImageProps;
}) {
  const dialog = useDialogContext();

  const form = useForm({ defaultValues: { sourceImage, steps: 2 }, schema });
  const watched = form.watch();

  const generate = useGenerate();

  const whatIf = trpc.orchestrator.whatIf.useQuery(
    { type: 'image', data: { workflow, type: 'img2img', ...watched } },
    {
      enabled: Object.keys(watched).length > 0,
    }
  );

  function handleSubmit(data: z.infer<typeof schema>) {
    generate.mutate({
      type: 'image',
      data: { workflow, type: 'img2img', ...data },
    });
  }

  return (
    <Modal {...dialog} title="Upscale Enhancement">
      <GenerationProvider>
        <Form form={form} onSubmit={handleSubmit} className="flex flex-col gap-3">
          <InputSourceImageUpload
            name="sourceImage"
            removable={false}
            upscaleMultiplier
            upscaleResolution
          />
          <InputNumberSlider name="steps" label="Enhancement Steps" min={0} max={3} step={1} />
          <WhatIfAlert error={whatIf.error} />
          <GenerateButton
            type="submit"
            loading={whatIf.isInitialLoading || generate.isLoading}
            cost={whatIf.data?.cost?.total ?? 0}
            disabled={whatIf.isError}
          >
            Upscale
          </GenerateButton>
        </Form>
      </GenerationProvider>
    </Modal>
  );
}
