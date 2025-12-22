import { Divider, Input, Modal, Notification, Alert, Loader } from '@mantine/core';
import * as z from 'zod';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { useGenerateWithCost } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';
import { IconX } from '@tabler/icons-react';
import { GenForm } from '~/components/Generation/Form/GenForm';
import { EdgeVideo } from '~/components/EdgeMedia/EdgeVideo';
import { useEffect, useMemo, useState } from 'react';
import { getVideoData } from '~/utils/media-preprocessors';
import { Radio } from '~/libs/form/components/RadioGroup';
import { Controller } from 'react-hook-form';

const schema = z.object({
  scaleFactor: z.number(),
});

export function UpscaleVideoModal({
  videoUrl,
  scaleFactor = 2,
  metadata,
  multipliers = [2, 3],
  maxResolution = 2560,
}: {
  videoUrl: string;
  scaleFactor?: number;
  metadata: Record<string, unknown>;
  multipliers?: number[];
  maxResolution?: number;
}) {
  const dialog = useDialogContext();

  const defaultValues = { scaleFactor };
  const form = useForm({ defaultValues, schema });
  const watched = form.watch();
  const [video, setVideo] = useState<HTMLVideoElement>();
  const min = video ? Math.max(video.videoWidth, video.videoHeight) : undefined;
  const canUpscale = !!min && min * Math.min(...multipliers) <= maxResolution;

  const whatIf = trpc.orchestrator.whatIf.useQuery(
    {
      $type: 'videoUpscaler',
      data: { videoUrl, ...defaultValues, ...watched },
    },
    { enabled: canUpscale }
  );

  const generate = useGenerateWithCost(whatIf.data?.cost?.total);

  async function handleSubmit(data: z.infer<typeof schema>) {
    await generate.mutate({
      $type: 'videoUpscaler',
      data: { videoUrl, ...data, metadata },
    });
    dialog.onClose();
  }

  useEffect(() => {
    getVideoData(videoUrl).then((data) => setVideo(data));
  }, [videoUrl]);

  const multiplierOptions = useMemo(() => {
    if (!video || !min) return;
    return multipliers.map((multiplier) => ({
      value: multiplier,
      label: `x${multiplier}`,
      disabled: multiplier * min > maxResolution,
    }));
  }, [video, min]);

  return (
    <Modal {...dialog} title="Upscale">
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
          {!video ? (
            <div className="flex justify-center">
              <Loader />
            </div>
          ) : !canUpscale ? (
            <Alert color="yellow">This video cannot be upscaled any further.</Alert>
          ) : (
            <>
              {multiplierOptions && (
                <Input.Wrapper label="Scale Factor">
                  <Controller
                    control={form.control}
                    name="scaleFactor"
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
              {video && (
                <div className="rounded-md bg-gray-2 px-6 py-4 dark:bg-dark-6">
                  <span className="font-bold">Upscale Dimensions:</span>{' '}
                  {watched.scaleFactor * video.videoWidth} x{' '}
                  {watched.scaleFactor * video.videoHeight}
                </div>
              )}
              <Divider />
              <WhatIfAlert error={whatIf.error} />
              {generate.error?.message && (
                <Notification
                  icon={<IconX size={18} />}
                  color="red"
                  className="rounded-md bg-red-8/20"
                >
                  {generate.error.message}
                </Notification>
              )}
              <GenerateButton
                type="submit"
                loading={whatIf.isInitialLoading || generate.isLoading}
                cost={whatIf.data?.cost?.total ?? 0}
                disabled={whatIf.isError}
                allowMatureContent={whatIf.data?.allowMatureContent}
                transactions={whatIf.data?.transactions}
              >
                Upscale
              </GenerateButton>
            </>
          )}
        </GenForm>
      </GenerationProvider>
    </Modal>
  );
}
