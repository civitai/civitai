/**
 * BackgroundRemovalModal
 *
 * Modal for removing backgrounds from generated images using the new generation-graph routes.
 * Uses img2img:remove-background workflow with the generateFromGraph/whatIfFromGraph endpoints.
 */

import { Alert, Modal, Notification } from '@mantine/core';
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
import { InputSourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';
import type { SourceMetadata } from '~/store/source-metadata.store';

// =============================================================================
// Types
// =============================================================================

interface SourceImageProps {
  url: string;
  width: number;
  height: number;
}

interface BackgroundRemovalModalProps {
  /** The source image for background removal */
  sourceImage: SourceImageProps;
  /** Optional metadata from the original generation */
  metadata?: Omit<SourceMetadata, 'extractedAt'>;
}

// =============================================================================
// Schema
// =============================================================================

const schema = z.object({
  sourceImage: z.object({
    url: z.string(),
    width: z.number(),
    height: z.number(),
  }),
});

type FormData = z.infer<typeof schema>;

// =============================================================================
// Component
// =============================================================================

export function BackgroundRemovalModal({ sourceImage, metadata }: BackgroundRemovalModalProps) {
  const dialog = useDialogContext();

  const defaultValues: FormData = { sourceImage };
  const form = useForm({ defaultValues, schema });
  // Note: useForm from ~/libs/form uses shouldUnregister: true, so watched fields
  // are undefined until the input component registers them. Use the prop as fallback.
  const watched = form.watch();
  const currentImage = watched.sourceImage ?? sourceImage;

  // Build graph-compatible input for whatIf query
  const graphInput = {
    workflow: 'img2img:remove-background',
    images: [
      {
        url: currentImage.url,
        width: currentImage.width,
        height: currentImage.height,
      },
    ],
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
          workflow: 'img2img:remove-background',
          images: [
            {
              url: data.sourceImage.url,
              width: data.sourceImage.width,
              height: data.sourceImage.height,
            },
          ],
        },
        sourceMetadata: metadata,
      });
      dialog.onClose();
    }

    conditionalPerformTransaction(totalCost, performTransaction);
  }

  return (
    <Modal {...dialog} title="Background Removal">
      <GenerationProvider>
        <GenForm form={form} onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Alert>
            Background Removal works best with images that have a well-defined subject, preferably
            on a distinct background with sharp outlines. For the best results, use images where the
            subject stands out clearly. This feature is especially effective for &apos;sticker&apos;
            prompts!
          </Alert>
          <InputSourceImageUpload name="sourceImage" removable={false} />
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
            disabled={whatIf.isError}
            allowMatureContent={whatIf.data?.allowMatureContent}
            transactions={whatIf.data?.transactions}
          >
            Remove Background
          </GenerateButton>
        </GenForm>
      </GenerationProvider>
    </Modal>
  );
}
