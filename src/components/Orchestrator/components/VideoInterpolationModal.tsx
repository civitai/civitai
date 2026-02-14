/**
 * VideoInterpolationModal
 *
 * Modal for interpolating video frames using the new generation-graph routes.
 * Uses vid2vid:interpolate workflow with the generateFromGraph/whatIfFromGraph endpoints.
 */

import { Alert, Divider, Input, Loader, Modal, Notification } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import * as z from 'zod';
import { Controller } from 'react-hook-form';
import { useEffect, useMemo, useState } from 'react';

import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { GenForm } from '~/components/Generation/Form/GenForm';
import { useForm } from '~/libs/form';
import { Radio } from '~/libs/form/components/RadioGroup';
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

interface VideoInterpolationModalProps {
  /** URL of the video to interpolate */
  videoUrl: string;
  /** Default interpolation factor */
  interpolationFactor?: number;
  /** Optional metadata from the original generation */
  metadata?: Omit<SourceMetadata, 'extractedAt'>;
  /** Available multiplier options */
  multipliers?: number[];
  /** Maximum frames allowed in output */
  maxFrames?: number;
}

// =============================================================================
// Schema
// =============================================================================

const schema = z.object({
  interpolationFactor: z.number(),
});

type FormData = z.infer<typeof schema>;

// =============================================================================
// Component
// =============================================================================

export function VideoInterpolationModal({
  videoUrl,
  interpolationFactor = 2,
  metadata,
  multipliers = [2, 3, 4],
  maxFrames = 120,
}: VideoInterpolationModalProps) {
  const dialog = useDialogContext();

  const defaultValues: FormData = { interpolationFactor };
  const form = useForm({ defaultValues, schema });
  // Note: useForm from ~/libs/form uses shouldUnregister: true, so watched fields
  // are undefined until the input component registers them. Use the prop as fallback.
  const watched = form.watch();
  const currentFactor = watched.interpolationFactor ?? interpolationFactor;
  const [video, setVideo] = useState<HTMLVideoElement>();

  // Get video metadata for FPS info
  const { data: videoMetadata, isLoading: isLoadingMetadata } =
    trpc.orchestrator.getVideoMetadata.useQuery({ videoUrl });

  const fps = videoMetadata?.fps;
  const enabled = !!fps && fps * Math.min(...multipliers) <= maxFrames;
  const targetFps = fps ? currentFactor * fps : undefined;

  // Build graph-compatible input for whatIf query
  const graphInput = {
    workflow: 'vid2vid:interpolate',
    video: videoUrl,
    interpolationFactor: currentFactor,
  };

  const whatIf = trpc.orchestrator.whatIfFromGraph.useQuery(graphInput, {
    enabled: enabled && !!videoUrl,
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

  const multiplierOptions = useMemo(() => {
    if (!fps) return;
    return multipliers.map((multiplier) => ({
      value: multiplier,
      label: `x${multiplier}`,
      disabled: multiplier * fps > maxFrames,
    }));
  }, [fps, multipliers, maxFrames]);

  async function handleSubmit(data: FormData) {
    const totalCost = whatIf.data?.cost?.total ?? 0;

    async function performTransaction() {
      await generateMutation.mutateAsync({
        input: {
          workflow: 'vid2vid:interpolate',
          video: videoUrl,
          interpolationFactor: data.interpolationFactor,
        },
        sourceMetadata: metadata,
      });
      dialog.onClose();
    }

    conditionalPerformTransaction(totalCost, performTransaction);
  }

  return (
    <Modal {...dialog} title="Video Interpolation">
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

          {isLoadingMetadata || !video ? (
            <div className="flex justify-center">
              <Loader />
            </div>
          ) : !enabled ? (
            <Alert color="yellow">This video cannot be interpolated any further.</Alert>
          ) : (
            <>
              {multiplierOptions && (
                <Input.Wrapper label="Interpolation Factor">
                  <Controller
                    control={form.control}
                    name="interpolationFactor"
                    render={({ field }) => (
                      <Radio.Group {...field} className="flex gap-2">
                        {multiplierOptions.map(({ label, value, disabled }) => (
                          <Radio.Item key={value} value={value} label={label} disabled={disabled} />
                        ))}
                      </Radio.Group>
                    )}
                  />
                </Input.Wrapper>
              )}
              {targetFps && (
                <div className="rounded-md bg-gray-2 px-6 py-4 dark:bg-dark-6">
                  <span className="font-bold">Target FPS:</span> {targetFps}
                </div>
              )}
              <Divider />
              <WhatIfAlert error={whatIf.error} />
              {generateMutation.error?.message && (
                <Notification
                  icon={<IconX size={18} />}
                  color="red"
                  className="rounded-md bg-red-8/20"
                >
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
                Interpolate
              </GenerateButton>
            </>
          )}
        </GenForm>
      </GenerationProvider>
    </Modal>
  );
}
