import { Divider, Modal, Notification } from '@mantine/core';
import { z } from 'zod';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import {
  useGenerateWithCost,
  useSubmitCreateImage,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { Form, useForm } from '~/libs/form';
import { generationConfig } from '~/server/common/constants';
import {
  SourceImageProps,
  sourceImageSchema,
} from '~/server/orchestrator/infrastructure/base.schema';
import { TextToImageInput } from '~/server/schema/orchestrator/textToImage.schema';
import { GenerationResource } from '~/server/services/generation/generation.service';
import { getBaseModelSetType, whatIfQueryOverrides } from '~/shared/constants/generation.constants';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';
import { showErrorNotification } from '~/utils/notifications';
import { IconX } from '@tabler/icons-react';

const schema = z.object({
  sourceImage: sourceImageSchema,
});

export function UpscaleImageModal({
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
    <Modal {...dialog} title="Upscale">
      <GenerationProvider>
        <Form form={form} className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <InputSourceImageUpload
            name="sourceImage"
            removable={false}
            upscaleMultiplier
            upscaleResolution
          />
          <Divider />
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

function UpscalImageForm({
  params: { engine, ...params },
  resources,
}: {
  params: TextToImageInput;
  resources: GenerationResource[];
}) {
  const dialog = useDialogContext();

  const form = useForm({
    schema,
    defaultValues: {
      sourceImage: params.sourceImage as any,
    },
  });

  const values = form.getValues();
  const [sourceImage = values.sourceImage] = form.watch(['sourceImage']);

  const defaultModel =
    generationConfig[getBaseModelSetType(params.baseModel) as keyof typeof generationConfig]
      ?.checkpoint ?? resources[0];

  const whatIf = trpc.orchestrator.getImageWhatIf.useQuery(
    {
      resources: [{ id: defaultModel.id }],
      params: {
        ...params,
        ...whatIfQueryOverrides,
        quantity: 1,
        sourceImage,
      },
    },
    {
      enabled: !!sourceImage?.upscaleWidth,
    }
  );

  const generateImage = useSubmitCreateImage();
  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
    type: 'Generation',
  });

  function handleSubmit(formData: z.infer<typeof schema>) {
    async function performTransaction() {
      await generateImage
        .mutateAsync({
          resources,
          params: {
            ...params,
            quantity: 1,
            ...formData,
          },
        })
        .catch((error: any) => {
          showErrorNotification({
            title: 'Failed to generate',
            error: new Error(error.message),
            reason: error.message ?? 'An unexpected error occurred. Please try again later.',
          });
        });
      dialog.onClose();
    }
    conditionalPerformTransaction(whatIf.data?.cost?.total ?? 0, performTransaction);
  }

  return (
    <GenerationProvider>
      <Form form={form} className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <InputSourceImageUpload
          name="sourceImage"
          removable={false}
          upscaleMultiplier
          upscaleResolution
        />
        <Divider />
        <WhatIfAlert error={whatIf.error} />
        <GenerateButton
          type="submit"
          loading={whatIf.isInitialLoading || generateImage.isLoading}
          cost={whatIf.data?.cost?.total ?? 0}
          disabled={whatIf.isError}
        >
          Upscale
        </GenerateButton>
      </Form>
    </GenerationProvider>
  );
}
