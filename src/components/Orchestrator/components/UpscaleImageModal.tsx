import { Divider, Modal, Notification } from '@mantine/core';
import * as z from 'zod';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InputSourceImageUpscale } from '~/components/Generation/Input/SourceImageUpscale';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import {
  useGenerateWithCost,
  useSubmitCreateImage,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { Form, useForm } from '~/libs/form';
import { generationConfig, maxUpscaleSize } from '~/server/common/constants';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { sourceImageSchema } from '~/server/orchestrator/infrastructure/base.schema';
import type { TextToImageInput } from '~/server/schema/orchestrator/textToImage.schema';
import type { GenerationResource } from '~/shared/types/generation.types';
import { getBaseModelSetType, whatIfQueryOverrides } from '~/shared/constants/generation.constants';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';
import { showErrorNotification } from '~/utils/notifications';
import { IconX } from '@tabler/icons-react';
import { GenForm } from '~/components/Generation/Form/GenForm';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';

const schema = z.object({
  sourceImage: sourceImageSchema.refine(
    (data) => data.width < maxUpscaleSize && data.height < maxUpscaleSize
  ),
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
  const form = useForm({ defaultValues, schema, reValidateMode: 'onChange' });
  const watched = form.watch();

  console.log(form.formState.isValid);

  const whatIf = trpc.orchestrator.whatIf.useQuery({
    $type: 'image',
    data: { workflow, process: 'img2img', ...defaultValues, ...watched },
  });

  const generate = useGenerateWithCost(whatIf.data?.cost?.total);

  async function handleSubmit(data: z.infer<typeof schema>) {
    await generate.mutate({
      $type: 'image',
      data: { workflow, process: 'img2img', ...data, metadata },
    });
    dialog.onClose();
  }

  return (
    <Modal {...dialog} title="Upscale">
      <GenerationProvider>
        <GenForm form={form} className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <InputSourceImageUpscale
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
            disabled={whatIf.isError || !form.formState.isValid}
            allowMatureContent={whatIf.data?.allowMatureContent}
            transactions={whatIf.data?.transactions}
          >
            Upscale
          </GenerateButton>
        </GenForm>
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
    accountTypes: buzzSpendTypes,
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
        <InputSourceImageUpscale
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
          allowMatureContent={whatIf.data?.allowMatureContent}
          transactions={whatIf.data?.transactions}
        >
          Upscale
        </GenerateButton>
      </Form>
    </GenerationProvider>
  );
}
