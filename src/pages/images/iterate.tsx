import { Title } from '@mantine/core';
import { IconMessages } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useMemo } from 'react';

import { IterativeImageEditor } from '~/components/IterativeEditor/IterativeImageEditor';
import type {
  GenerateParams,
  PollParams,
  SourceImage,
  IterativeEditorConfig,
} from '~/components/IterativeEditor/iterative-editor.types';
import {
  COMIC_MODEL_MAX_IMAGES,
  COMIC_MODEL_OPTIONS,
  COMIC_MODEL_SIZES,
} from '~/components/Comics/comic-project-constants';
import { showSuccessNotification } from '~/utils/notifications';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session) {
      return {
        redirect: { destination: '/login', permanent: false },
      };
    }
  },
});

const DEFAULT_MODEL = 'NanoBanana';
const GENERATION_COST = 2;
const ENHANCE_COST = 1;

const config: IterativeEditorConfig = {
  modelOptions: COMIC_MODEL_OPTIONS,
  modelSizes: COMIC_MODEL_SIZES,
  modelMaxImages: COMIC_MODEL_MAX_IMAGES,
  defaultModel: DEFAULT_MODEL,
  defaultAspectRatio: '3:4',
  generationCost: GENERATION_COST,
  enhanceCost: ENHANCE_COST,
  commitLabel: 'Save Image',
};

export default function IteratePage() {
  const router = useRouter();
  const { imageUrl, width, height } = router.query;

  const initialSource: SourceImage | null = useMemo(() => {
    if (typeof imageUrl !== 'string') return null;
    const w = typeof width === 'string' ? parseInt(width, 10) : 512;
    const h = typeof height === 'string' ? parseInt(height, 10) : 512;
    return {
      url: imageUrl,
      previewUrl: imageUrl,
      width: w,
      height: h,
    };
  }, [imageUrl, width, height]);

  const iterateGenerateMutation = trpc.orchestrator.iterateGenerate.useMutation();
  const utils = trpc.useUtils();

  const handleGenerate = useCallback(
    async (params: GenerateParams) => {
      return iterateGenerateMutation.mutateAsync({
        prompt: params.prompt,
        enhance: params.enhance,
        aspectRatio: params.aspectRatio,
        baseModel: params.baseModel,
        quantity: params.quantity,
        ...(params.sourceImageUrl
          ? {
              sourceImageUrl: params.sourceImageUrl,
              sourceImageWidth: params.sourceImageWidth,
              sourceImageHeight: params.sourceImageHeight,
            }
          : {}),
      });
    },
    [iterateGenerateMutation]
  );

  const handlePollStatus = useCallback(
    async (params: PollParams) => {
      return utils.orchestrator.pollIterationStatus.fetch(params);
    },
    [utils]
  );

  const handleCommit = useCallback(async (_source: SourceImage) => {
    showSuccessNotification({ message: 'Image saved successfully!' });
  }, []);

  const handleClose = useCallback(() => {
    void router.push('/images');
  }, [router]);

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          padding: '12px 24px',
          borderBottom: '1px solid #373a40',
          borderImage: 'linear-gradient(90deg, #fab005, #fd7e14, transparent) 1',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <IconMessages size={20} />
        <Title order={4}>Iterative Image Editor</Title>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <IterativeImageEditor
          initialSource={initialSource}
          config={config}
          onGenerate={handleGenerate}
          onPollStatus={handlePollStatus}
          onCommit={handleCommit}
          onClose={handleClose}
          mode="page"
        />
      </div>
    </div>
  );
}
