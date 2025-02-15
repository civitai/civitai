import { Alert, Loader, Modal, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { Controller } from 'react-hook-form';
import { z } from 'zod';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { UpscalePicker } from '~/components/ImageGeneration/GenerationForm/UpscalePicker';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { useSubmitCreateImage } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { Form, useForm } from '~/libs/form';
import { generationConfig } from '~/server/common/constants';
import { TextToImageInput } from '~/server/schema/orchestrator/textToImage.schema';
import { GenerationResource } from '~/server/services/generation/generation.service';
import {
  getBaseModelSetType,
  getRoundedUpscaleSize,
  whatIfQueryOverrides,
} from '~/shared/constants/generation.constants';
import { getImageData } from '~/utils/media-preprocessors';
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
  resources,
}: {
  resources: GenerationResource[];
  params: TextToImageInput;
}) {
  const dialog = useDialogContext();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.image)
      getImageData(params.image)
        .then(({ width, height }) => {
          setSize({ width, height });
        })
        .catch((e) => setError('failed to load image'));
    else {
      setSize(null);
    }
  }, [params.image]);

  return (
    <Modal {...dialog}>
      {error ? (
        <Alert color="red">{error}</Alert>
      ) : !size ? (
        <div className="flex h-72 items-center justify-center">
          <Loader />
        </div>
      ) : (
        <UpscalImageForm params={{ ...params, ...size }} resources={resources} />
      )}
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

  const upscale = getRoundedUpscaleSize({ width: params.width * 1.5, height: params.height * 1.5 });

  const form = useForm({
    schema,
    defaultValues: {
      width: params.width,
      height: params.height,
      upscaleWidth: upscale.width,
      upscaleHeight: upscale.height,
    },
  });

  const values = form.getValues();
  const [upscaleWidth = values.upscaleWidth, upscaleHeight = values.upscaleHeight] = form.watch([
    'upscaleWidth',
    'upscaleHeight',
  ]);

  const defaultModel =
    generationConfig[getBaseModelSetType(params.baseModel) as keyof typeof generationConfig]
      ?.checkpoint ?? resources[0];

  const { data, isLoading, isInitialLoading, isError } = trpc.orchestrator.getImageWhatIf.useQuery(
    {
      resources: [{ id: defaultModel.id }],
      params: {
        ...params,
        ...whatIfQueryOverrides,
        quantity: 1,
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
    async function performTransaction() {
      await generateImage.mutateAsync({
        resources,
        params: {
          ...params,
          quantity: 1,
          ...formData,
        },
      });
      dialog.onClose();
    }
    conditionalPerformTransaction(data?.cost?.total ?? 0, performTransaction);
  }

  return (
    <GenerationProvider>
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
        <UpscalePicker label="Upscale multipliers" width={params.width} height={params.height} />
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
    </GenerationProvider>
  );
}
