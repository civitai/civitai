import { Modal, Alert } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { Form, useForm } from '~/libs/form';
import { trpc } from '~/utils/trpc';
import { useGenerate } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { WhatIfAlert } from '~/components/Generation/Alerts/WhatIfAlert';
import { useEffect, useMemo, useState } from 'react';
import { getVideoData } from '~/utils/media-preprocessors';
import type { VideoMetadata } from '~/server/schema/media.schema';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { TwCard } from '~/components/TwCard/TwCard';
import { GenForm } from '~/components/Generation/Form/GenForm';
import * as z from 'zod';

const schema = z.looseObject({});

export function EnhanceVideoModal({
  sourceUrl,
  params,
}: {
  sourceUrl: string;
  params: Record<string, unknown>;
}) {
  const dialog = useDialogContext();
  const form = useForm({ schema });
  const generate = useGenerate();
  const [video, setVideo] = useState<VideoMetadata>();

  useEffect(() => {
    getVideoData(sourceUrl).then((data) => {
      setVideo(data);
    });
  }, [sourceUrl]);

  const upscaleDimensions = useMemo(() => {
    if (!video) {
      return {
        width: 0,
        height: 0,
        canUpscale: false,
      };
    }
    const width = video.width * 2;
    const height = video.height * 2;
    return {
      width,
      height,
      canUpscale: width * height <= 1000000, // 1 million dollars!
    };
  }, [video]);

  const whatIf = trpc.orchestrator.whatIf.useQuery(
    {
      $type: 'videoEnhancement',
      data: {
        sourceUrl,
        width: upscaleDimensions.width,
        height: upscaleDimensions.height,
        params,
      },
    },
    { enabled: !!upscaleDimensions?.canUpscale }
  );

  async function handleSubmit() {
    await generate.mutateAsync({
      $type: 'videoEnhancement',
      data: {
        sourceUrl,
        width: upscaleDimensions.width,
        height: upscaleDimensions.height,
        params,
      },
    });
    dialog.onClose();
  }

  return (
    <Modal {...dialog} title="Upscale">
      <GenerationProvider>
        <GenForm form={form} onSubmit={handleSubmit} className="flex flex-col gap-3">
          <TwCard className="gap-1 border">
            <EdgeMedia2 src={sourceUrl} type="video" className="w-auto" />
            {video && (
              <div className="absolute bottom-0 right-0 rounded-tl-md bg-dark-9/50 px-2 text-white">
                {video.width} x {video.height}
              </div>
            )}
          </TwCard>
          {video &&
            (upscaleDimensions.canUpscale ? (
              <div className="rounded-md bg-gray-2 px-6 py-4 dark:bg-dark-6">
                <span className="font-bold">Upscale Dimensions:</span> {upscaleDimensions.width} x{' '}
                {upscaleDimensions.height}
              </div>
            ) : (
              <Alert color="yellow">Selected video is too large to upscale</Alert>
            ))}

          <WhatIfAlert error={whatIf.error} />
          <GenerateButton
            type="submit"
            loading={whatIf.isInitialLoading || generate.isLoading}
            cost={whatIf.data?.cost?.total ?? 0}
            disabled={whatIf.isError}
          >
            Upscale
          </GenerateButton>
        </GenForm>
      </GenerationProvider>
    </Modal>
  );
}

const upscaleMultipliers = [1.5, 2];
