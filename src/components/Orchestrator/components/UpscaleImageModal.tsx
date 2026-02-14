/**
 * UpscaleImageModal
 *
 * Modal for upscaling generated images using the new generation-graph routes.
 * Uses img2img:upscale workflow with the generateFromGraph/whatIfFromGraph endpoints.
 */

import { Divider, Modal, Notification } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import * as z from 'zod';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { GenForm } from '~/components/Generation/Form/GenForm';
import { useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { maxUpscaleSize } from '~/server/common/constants';
import { InputSourceImageUpscale } from '~/components/Generation/Input/SourceImageUpscale';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';
import type { SourceMetadata } from '~/store/source-metadata.store';

// =============================================================================
// Types
// =============================================================================

interface SourceImageProps {
  url: string;
  width: number;
  height: number;
  upscaleWidth?: number;
  upscaleHeight?: number;
  upscaleMultiplier?: number;
}

interface UpscaleImageModalProps {
  /** The source image to upscale */
  sourceImage: SourceImageProps;
  /** Optional metadata from the original generation */
  metadata?: Omit<SourceMetadata, 'extractedAt'>;
}

// =============================================================================
// Schema
// =============================================================================

const schema = z.object({
  sourceImage: z
    .object({
      url: z.string(),
      width: z.number(),
      height: z.number(),
      upscaleWidth: z.number().optional(),
      upscaleHeight: z.number().optional(),
      upscaleMultiplier: z.number().optional(),
    })
    .refine((data) => {
      const targetWidth = data.upscaleWidth ?? data.width;
      const targetHeight = data.upscaleHeight ?? data.height;
      return targetWidth < maxUpscaleSize && targetHeight < maxUpscaleSize;
    }, `Output dimensions must be less than ${maxUpscaleSize}px`),
});

type FormData = z.infer<typeof schema>;

// =============================================================================
// Component
// =============================================================================

export function UpscaleImageModal({ sourceImage, metadata }: UpscaleImageModalProps) {
  const dialog = useDialogContext();

  const defaultValues: FormData = { sourceImage };
  const form = useForm({ defaultValues, schema, reValidateMode: 'onChange' });
  // Note: useForm from ~/libs/form uses shouldUnregister: true, so watched fields
  // are undefined until the input component registers them. Use the prop as fallback.
  const watched = form.watch();
  const currentImage = watched.sourceImage ?? sourceImage;

  // Build graph-compatible input for whatIf query
  const graphInput = {
    workflow: 'img2img:upscale',
    images: [
      {
        url: currentImage.url,
        width: currentImage.width,
        height: currentImage.height,
      },
    ],
    scaleFactor: currentImage.upscaleMultiplier ?? 2,
  };

  const whatIf = trpc.orchestrator.whatIfFromGraph.useQuery(graphInput, {
    enabled: !!currentImage.url,
  });

  const generateMutation = trpc.orchestrator.generateFromGraph.useMutation();

  const { conditionalPerformTransaction } = useBuzzTransaction({
    accountTypes: buzzSpendTypes,
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  async function handleSubmit(data: FormData) {
    const totalCost = whatIf.data?.cost?.total ?? 0;

    async function performTransaction() {
      await generateMutation.mutateAsync({
        input: {
          workflow: 'img2img:upscale',
          images: [
            {
              url: data.sourceImage.url,
              width: data.sourceImage.width,
              height: data.sourceImage.height,
            },
          ],
          scaleFactor: data.sourceImage.upscaleMultiplier ?? 2,
        },
        sourceMetadata: metadata,
      });
      dialog.onClose();
    }

    conditionalPerformTransaction(totalCost, performTransaction);
  }

  return (
    <Modal {...dialog} title="Upscale Image">
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
          {generateMutation.error?.message && (
            <Notification icon={<IconX size={18} />} color="red" className="rounded-md bg-red-8/20">
              {generateMutation.error.message}
            </Notification>
          )}
          <GenerateButton
            type="submit"
            loading={whatIf.isInitialLoading || generateMutation.isLoading}
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
