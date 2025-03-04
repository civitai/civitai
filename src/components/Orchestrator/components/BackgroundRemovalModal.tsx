import { Modal, Text, Alert } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { Form, useForm } from '~/libs/form';
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
});

export function BackgroundRemovalModal({
  workflow,
  sourceImage,
}: {
  workflow: string;
  sourceImage: SourceImageProps;
}) {
  const dialog = useDialogContext();

  const defaultValues = { sourceImage };
  const form = useForm({ defaultValues, schema });
  const watched = form.watch();

  const generate = useGenerate();

  const whatIf = trpc.orchestrator.whatIf.useQuery({
    type: 'image',
    data: { workflow, type: 'img2img', ...defaultValues, ...watched },
  });

  async function handleSubmit(data: z.infer<typeof schema>) {
    await generate.mutateAsync({
      type: 'image',
      data: { workflow, type: 'img2img', ...data },
    });
    dialog.onClose();
  }

  return (
    <Modal {...dialog} title="Background Removal">
      <GenerationProvider>
        <Form form={form} onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Alert>
            Background Removal works best with images that have a well-defined subject, preferably
            on a distinct background with sharp outlines. For the best results, use images where the
            subject stands out clearly. This feature is especially effective for ‘sticker’ prompts!
          </Alert>
          <InputSourceImageUpload name="sourceImage" removable={false} />
          <WhatIfAlert error={whatIf.error} />
          <GenerateButton
            type="submit"
            loading={whatIf.isInitialLoading || generate.isLoading}
            cost={whatIf.data?.cost?.total ?? 0}
            disabled={whatIf.isError}
          >
            Remove Background
          </GenerateButton>
        </Form>
      </GenerationProvider>
    </Modal>
  );
}
