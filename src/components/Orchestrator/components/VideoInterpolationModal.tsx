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
  interpolationFactor: z.number(),
});

export function VideoInterpolationModal({
  videoUrl,
  interpolationFactor = 2,
  metadata,
  multipliers = [2, 3, 4],
  maxFrames = 120,
}: {
  videoUrl: string;
  interpolationFactor?: number;
  metadata: Record<string, unknown>;
  multipliers?: number[];
  maxFrames?: number;
}) {
  const dialog = useDialogContext();

  const defaultValues = { interpolationFactor };
  const form = useForm({ defaultValues, schema });
  const watched = form.watch();
  const [video, setVideo] = useState<HTMLVideoElement>();
  const formData = { ...defaultValues, ...watched };

  const { data: videoMetadata, isLoading } = trpc.orchestrator.getVideoMetadata.useQuery({
    videoUrl,
  });
  const fps = videoMetadata?.fps;
  const enabled = !!fps && fps * Math.min(...multipliers) <= maxFrames;
  const targetFps = fps ? formData.interpolationFactor * fps : undefined;

  const whatIf = trpc.orchestrator.whatIf.useQuery(
    {
      $type: 'videoInterpolation',
      data: { videoUrl, ...formData },
    },
    { enabled }
  );

  const generate = useGenerateWithCost(whatIf.data?.cost?.total);

  async function handleSubmit(data: z.infer<typeof schema>) {
    await generate.mutate({
      $type: 'videoInterpolation',
      data: { videoUrl, ...data, metadata },
    });
    dialog.onClose();
  }

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
  }, [fps]);

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

          {isLoading || !video ? (
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
                Interpolate
              </GenerateButton>
            </>
          )}
        </GenForm>
      </GenerationProvider>
    </Modal>
  );
}
