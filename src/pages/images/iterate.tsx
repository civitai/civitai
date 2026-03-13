import { Title } from '@mantine/core';
import { IconMessages } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';

import { Page } from '~/components/AppLayout/Page';
import { IterativeImageEditor } from '~/components/IterativeEditor/IterativeImageEditor';
import type {
  CostEstimateParams,
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

const config: IterativeEditorConfig = {
  modelOptions: COMIC_MODEL_OPTIONS,
  modelSizes: COMIC_MODEL_SIZES,
  modelMaxImages: COMIC_MODEL_MAX_IMAGES,
  defaultModel: DEFAULT_MODEL,
  defaultAspectRatio: '3:4',
  generationCost: 25, // fallback if whatIf unavailable
  enhanceCost: 0,
  commitLabel: 'Save Image',
};

function IteratePage() {
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

  // ── Dynamic whatIf cost estimation ──
  const [costParams, setCostParams] = useState<CostEstimateParams>({
    baseModel: DEFAULT_MODEL,
    aspectRatio: '3:4',
    quantity: 1,
  });

  const {
    data: iterateCostEstimate,
    isFetching: isCostFetching,
    refetch: refetchCost,
  } = trpc.orchestrator.getIterateCostEstimate.useQuery(
    {
      baseModel: costParams.baseModel,
      aspectRatio: costParams.aspectRatio,
      quantity: costParams.quantity,
      sourceImage: costParams.sourceImage ?? undefined,
      referenceImages: costParams.referenceImages,
    },
    { staleTime: 30_000, keepPreviousData: true }
  );

  const handleSettingsChange = useCallback((params: CostEstimateParams) => {
    setCostParams(params);
  }, []);

  const handleRetryCost = useCallback(() => {
    void refetchCost();
  }, [refetchCost]);

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
        ...(params.referenceImages?.length ? { referenceImages: params.referenceImages } : {}),
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
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div
        style={{
          padding: '12px 24px',
          borderBottom: '1px solid #373a40',
          borderImage: 'linear-gradient(90deg, #fab005, #fd7e14, transparent) 1',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexShrink: 0,
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
          costEstimate={iterateCostEstimate ?? null}
          isCostLoading={isCostFetching}
          onSettingsChange={handleSettingsChange}
          onRetryCost={handleRetryCost}
          mode="page"
        />
      </div>
    </div>
  );
}

export default Page(IteratePage, {
  scrollable: false,
  header: null,
  footer: null,
});
