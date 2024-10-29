import { Modal, Text } from '@mantine/core';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { UpscalePicker } from '~/components/ImageGeneration/GenerationForm/UpscalePicker';
import { useSubmitCreateImage } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { Form, useForm } from '~/libs/form';
import { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import { GenerationResource, whatIfQueryOverrides } from '~/shared/constants/generation.constants';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

const schema = z.object({
  width: z.number(),
  height: z.number(),
  upscaleWidth: z.number(),
  upscaleHeight: z.number(),
});

export function UpscaleImageModal({
  params: { aspectRatio, ...params },
}: {
  resources: GenerationResource[];
  params: TextToImageParams;
}) {
  const dialog = useDialogContext();

  const form = useForm({
    schema,
    defaultValues: {
      width: params.width,
      height: params.height,
    },
  });

  const [upscaleWidth, upscaleHeight] = form.watch(['upscaleWidth', 'upscaleHeight']);

  const { data, isLoading, isInitialLoading, isError } = trpc.orchestrator.getImageWhatIf.useQuery(
    {
      resources: [164821],
      params: {
        ...params,
        ...whatIfQueryOverrides,
        quantity: 1,
        baseModel: 'Other',
        upscaleWidth,
        upscaleHeight,
      },
    },
    {
      enabled: !!upscaleWidth && !!upscaleHeight,
    }
  );

  const generateImage = useSubmitCreateImage();
  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more buzz to perform this action.`,
    performTransactionOnPurchase: true,
    type: 'Generation',
  });

  function handleSubmit(formData: z.infer<typeof schema>) {
    console.log(data);
    async function performTransaction() {
      await generateImage.mutateAsync({
        resources: [{ id: 164821 }],
        params: {
          ...params,
          quantity: 1,
          baseModel: 'Other',
          ...formData,
        },
      });
      dialog.onClose();
    }
    conditionalPerformTransaction(data?.cost?.total ?? 0, performTransaction);
  }

  return (
    <Modal {...dialog}>
      <Form form={form} className="flex flex-col gap-3" onSubmit={handleSubmit}>
        {params.image && (
          <div className="flex flex-col items-end gap-0.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={params.image} alt="image to upscale" className="mx-auto max-w-full" />
            <Text color="dimmed" size="sm">
              Image dimensions: {params.width} x {params.height}
            </Text>
          </div>
        )}
        <Controller
          name="width"
          control={form.control}
          render={({ field: { value } }) => <input type="hidden" value={value ?? ''} />}
        />
        <Controller
          name="height"
          control={form.control}
          render={({ field: { value } }) => <input type="hidden" value={value ?? ''} />}
        />
        <UpscalePicker label="Upscale multipliers" />
        <GenerateButton
          type="submit"
          // onClick={handleSubmit}
          loading={isLoading || generateImage.isLoading}
          cost={data?.cost?.total ?? 0}
          error={
            !isInitialLoading && isError
              ? 'Error calculating cost. Please try updating your values'
              : undefined
          }
        >
          Upscale
        </GenerateButton>
      </Form>
    </Modal>
  );
}
