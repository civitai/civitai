/**
 * UpscaleVideoModal
 *
 * Modal for upscaling videos using the new generation-graph routes.
 * Uses vid2vid:upscale workflow with the generateFromGraph/whatIfFromGraph endpoints.
 */

import { Badge, Divider, Input, Modal, Notification, SegmentedControl } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import * as z from 'zod';
import { Controller } from 'react-hook-form';
import { useEffect, useState } from 'react';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { GenForm } from '~/components/Generation/Form/GenForm';
import { useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { numberWithCommas } from '~/utils/number-helpers';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { getVideoData } from '~/utils/media-preprocessors';
import type { SourceMetadata } from '~/store/source-metadata.store';

// =============================================================================
// Types
// =============================================================================

interface UpscaleVideoModalProps {
  /** URL of the video to upscale */
  videoUrl: string;
  /** Optional metadata from the original generation */
  metadata?: Omit<SourceMetadata, 'extractedAt'>;
}

// =============================================================================
// Schema
// =============================================================================

const schema = z.object({
  scaleFactor: z.number().min(1).max(4),
});

type FormData = z.infer<typeof schema>;

// =============================================================================
// Component
// =============================================================================

export function UpscaleVideoModal({ videoUrl, metadata }: UpscaleVideoModalProps) {
  const dialog = useDialogContext();

  const defaultValues: FormData = { scaleFactor: 2 };
  const form = useForm({ defaultValues, schema });
  // Note: useForm from ~/libs/form uses shouldUnregister: true, so watched fields
  // are undefined until the input component registers them. Use default as fallback.
  const watched = form.watch();
  const currentScaleFactor = watched.scaleFactor ?? 2;
  const [video, setVideo] = useState<HTMLVideoElement>();

  // Build graph-compatible input for whatIf query
  const graphInput = {
    workflow: 'vid2vid:upscale',
    video: videoUrl,
    scaleFactor: currentScaleFactor,
  };

  const whatIf = trpc.orchestrator.whatIfFromGraph.useQuery(graphInput, {
    enabled: !!videoUrl,
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

  useEffect(() => {
    getVideoData(videoUrl).then((data) => setVideo(data));
  }, [videoUrl]);

  // Calculate target dimensions
  const targetWidth = video ? video.videoWidth * currentScaleFactor : undefined;
  const targetHeight = video ? video.videoHeight * currentScaleFactor : undefined;

  async function handleSubmit(data: FormData) {
    const totalCost = whatIf.data?.cost?.total ?? 0;

    async function performTransaction() {
      await generateMutation.mutateAsync({
        input: {
          workflow: 'vid2vid:upscale',
          video: videoUrl,
          scaleFactor: data.scaleFactor,
        },
        sourceMetadata: metadata,
      });
      dialog.onClose();
    }

    conditionalPerformTransaction(totalCost, performTransaction);
  }

  const scaleOptions = [
    { value: '2', label: '2x' },
    { value: '4', label: '4x' },
  ];

  return (
    <Modal {...dialog} title="Upscale Video">
      <GenerationProvider>
        <GenForm form={form} className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <div className="relative">
            <EdgeVideo
              src={videoUrl}
              disableWebm
              disablePoster
              disablePictureInPicture
              playsInline
              options={{ anim: true }}
              style={{ maxHeight: 300 }}
            />
            {video && (
              <div className="absolute bottom-0 right-0 rounded-br-md rounded-tl-md bg-dark-9/50 px-2 text-white">
                {video.videoWidth} x {video.videoHeight}
              </div>
            )}
          </div>

          <Controller
            control={form.control}
            name="scaleFactor"
            render={({ field }) => (
              <Input.Wrapper label="Scale Factor">
                <SegmentedControl
                  value={field.value.toString()}
                  onChange={(v) => field.onChange(Number(v))}
                  data={scaleOptions}
                />
              </Input.Wrapper>
            )}
          />

          {targetWidth && targetHeight && (
            <div className="rounded-md bg-gray-2 px-6 py-4 dark:bg-dark-6">
              <span className="font-bold">Target Resolution:</span> {targetWidth} x {targetHeight}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Badge color="yellow">Preview</Badge>
            <span className="text-sm text-gray-6">Video upscaling is in preview</span>
          </div>

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
            disabled={whatIf.isError}
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
