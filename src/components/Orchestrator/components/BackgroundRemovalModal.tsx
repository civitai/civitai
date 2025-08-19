import { Modal, Alert, Notification } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { Form, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';
import {
  useGenerate,
  useGenerateWithCost,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import * as z from 'zod';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';
import { IconX } from '@tabler/icons-react';
import { GenForm } from '~/components/Generation/Form/GenForm';

const schema = z.object({
  sourceImage: sourceImageSchema,
});

export function BackgroundRemovalModal({
  workflow,
  sourceImage,
  metadata,
}: {
  workflow: string;
  sourceImage: SourceImageProps;
  metadata: Record<string, unknown>;
}) {
  const dialog = useDialogContext();

  const defaultValues = { sourceImage };
  const form = useForm({ defaultValues, schema });
  const watched = form.watch();

  const whatIf = trpc.orchestrator.whatIf.useQuery({
    $type: 'image',
    data: { workflow, process: 'img2img', ...defaultValues, ...watched },
  });
  const generate = useGenerateWithCost(whatIf.data?.cost?.total);

  async function handleSubmit(data: z.infer<typeof schema>) {
    await generate.mutateAsync({
      $type: 'image',
      data: { workflow, process: 'img2img', ...data, metadata },
    });
    dialog.onClose();
  }

  return (
    <Modal {...dialog} title="Background Removal">
      <GenerationProvider>
        <GenForm form={form} onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Alert>
            Background Removal works best with images that have a well-defined subject, preferably
            on a distinct background with sharp outlines. For the best results, use images where the
            subject stands out clearly. This feature is especially effective for ‘sticker’ prompts!
          </Alert>
          <InputSourceImageUpload name="sourceImage" removable={false} />
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
            Remove Background
          </GenerateButton>
        </GenForm>
      </GenerationProvider>
    </Modal>
  );
}
