import { Modal, Notification } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { Form, InputNumberSlider, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import {
  SourceImageProps,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { useGenerateWithCost } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { z } from 'zod';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';
import { IconX } from '@tabler/icons-react';

const schema = z.object({
  sourceImage: sourceImageSchema,
  steps: z.number().min(0).max(3).catch(2),
});

export function UpscaleEnhancementModal({
  workflow,
  sourceImage,
  metadata,
}: {
  workflow: string;
  sourceImage: SourceImageProps;
  metadata: Record<string, unknown>;
}) {
  const dialog = useDialogContext();

  const defaultValues = { sourceImage, steps: 2 };
  const form = useForm({ defaultValues, schema });
  const watched = form.watch();

  const whatIf = trpc.orchestrator.whatIf.useQuery({
    $type: 'image',
    data: { workflow, type: 'img2img', ...defaultValues, ...watched },
  });
  const generate = useGenerateWithCost(whatIf.data?.cost?.total);

  async function handleSubmit(data: z.infer<typeof schema>) {
    await generate.mutate({
      $type: 'image',
      data: { workflow, type: 'img2img', ...data, metadata },
    });
    dialog.onClose();
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
          {generate.error?.message && (
            <Notification icon={<IconX size={18} />} color="red" className="rounded-md bg-red-8/20">
              {generate.error.message}
            </Notification>
          )}
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
