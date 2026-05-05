import { ActionIcon, Alert, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconArrowLeft, IconMessages } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  COMIC_MODEL_MAX_IMAGES,
  COMIC_MODEL_OPTIONS,
  COMIC_MODEL_SIZES,
} from '~/components/Comics/comic-project-constants';
import { MentionTextarea } from '~/components/Comics/MentionTextarea';
import { IterativeImageEditor } from '~/components/IterativeEditor/IterativeImageEditor';
import type {
  CostEstimateParams,
  GenerateParams,
  InputSlotProps,
  IterativeEditorConfig,
  PollParams,
  SourceImage,
} from '~/components/IterativeEditor/iterative-editor.types';
import { Page } from '~/components/AppLayout/Page';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useServerDomains } from '~/providers/AppProvider';
import { hasSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { syncAccount } from '~/utils/sync-account';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!features?.comicCreator) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: '/login?returnUrl=/comics',
          permanent: false,
        },
      };
    }
  },
});

const DEFAULT_MODEL = 'NanoBanana';

function ComicIteratePage() {
  const router = useRouter();
  const {
    id,
    panelId,
    panelPosition,
    imageUrl,
    width,
    height,
    chapter,
    pendingWorkflow,
    pendingWidth,
    pendingHeight,
    pendingPrompt,
  } = router.query;
  const projectId = Number(id);
  const chapterPosition = Number(chapter) || 0;
  const numericPanelId = panelId ? Number(panelId) : null;
  const numericPanelPosition = Number(panelPosition) || 0;
  const redDomain = useServerDomains().red;

  // ── Fetch project data for references + cost ──
  // Iterate.tsx only needs `baseModel`, `references`, and `name` — no
  // chapter/panel data — so use the lightweight shell instead of `getProject`.
  const { data: project } = trpc.comics.getProjectShell.useQuery(
    { id: projectId },
    { enabled: !!projectId && !isNaN(projectId) }
  );

  // ── Dynamic whatIf cost estimation ──
  const [costParams, setCostParams] = useState<CostEstimateParams>({
    baseModel: project?.baseModel ?? DEFAULT_MODEL,
    aspectRatio: '3:4',
    quantity: 1,
  });

  const {
    data: iterateCostEstimate,
    isFetching: isCostFetching,
    refetch: refetchCost,
  } = trpc.comics.getGenerationCostEstimate.useQuery(
    {
      baseModel: costParams.baseModel,
      aspectRatio: costParams.aspectRatio,
      quantity: costParams.quantity,
      sourceImage: costParams.sourceImage ?? undefined,
      userReferenceImages: costParams.referenceImages,
      referenceIds: costParams.referenceIds,
      selectedImageIds: costParams.selectedImageIds,
    },
    { staleTime: 30_000, enabled: !!project, keepPreviousData: true }
  );

  const { data: enhanceCostEstimate } = trpc.comics.getPromptEnhanceCostEstimate.useQuery(
    undefined,
    { staleTime: 5 * 60 * 1000 }
  );

  const handleSettingsChange = useCallback((params: CostEstimateParams) => {
    setCostParams(params);
  }, []);

  const handleRetryCost = useCallback(() => {
    void refetchCost();
  }, [refetchCost]);

  const activeReferences = useMemo(
    () => (project?.references ?? []).filter((c: any) => c.status === 'Ready'),
    [project?.references]
  );

  const mentions = useMemo(
    () => activeReferences.map((c: any) => ({ id: c.id, name: c.name })),
    [activeReferences]
  );

  const initialSource: SourceImage | null = useMemo(() => {
    if (typeof imageUrl !== 'string') return null;
    const w = typeof width === 'string' ? parseInt(width, 10) : 1024;
    const h = typeof height === 'string' ? parseInt(height, 10) : 1024;
    return {
      url: imageUrl,
      previewUrl: getEdgeUrl(imageUrl, { width: 400 }) ?? imageUrl,
      width: w,
      height: h,
    };
  }, [imageUrl, width, height]);

  const config: IterativeEditorConfig = useMemo(
    () => ({
      modelOptions: COMIC_MODEL_OPTIONS,
      modelSizes: COMIC_MODEL_SIZES,
      modelMaxImages: COMIC_MODEL_MAX_IMAGES,
      defaultModel: project?.baseModel ?? DEFAULT_MODEL,
      defaultAspectRatio: '3:4',
      generationCost: 25, // fallback if whatIf unavailable
      enhanceCost: 0,
      commitLabel: 'Commit to Panel',
    }),
    [project?.baseModel]
  );

  // ── Mutations ──
  const iterateGenerateMutation = trpc.comics.iterateGenerate.useMutation({
    onError: (error) => showErrorNotification({ error, title: 'Failed to generate' }),
  });

  const replacePanelImageMutation = trpc.comics.replacePanelImage.useMutation({
    onError: (error) => showErrorNotification({ error, title: 'Failed to commit panel image' }),
  });

  const createPanelFromImageMutation = trpc.comics.enhancePanel.useMutation({
    onError: (error) => showErrorNotification({ error, title: 'Failed to create panel' }),
  });

  const utils = trpc.useUtils();

  const handleGenerate = useCallback(
    async (params: GenerateParams) => {
      return iterateGenerateMutation.mutateAsync({
        projectId,
        chapterPosition,
        prompt: params.prompt,
        aspectRatio: params.aspectRatio,
        baseModel: params.baseModel as any,
        quantity: params.quantity,
        ...(params.sourceImageUrl
          ? {
              sourceImageUrl: params.sourceImageUrl,
              sourceImageWidth: params.sourceImageWidth,
              sourceImageHeight: params.sourceImageHeight,
            }
          : {}),
        ...(params.selectedImageIds ? { selectedImageIds: params.selectedImageIds } : {}),
        ...(params.referenceImages?.length
          ? { userReferenceImages: params.referenceImages }
          : {}),
      });
    },
    [iterateGenerateMutation, projectId, chapterPosition]
  );

  const handlePollStatus = useCallback(
    async (params: PollParams) => {
      // staleTime/cacheTime 0 — without these, repeat polls of the same params
      // return the React Query cache and the editor never sees the workflow
      // transition. Mirrors the bypass `PanelCard` already uses.
      return utils.comics.pollIterationStatus.fetch(params, {
        staleTime: 0,
        cacheTime: 0,
      });
    },
    [utils]
  );

  const handleCommit = useCallback(
    async (source: SourceImage) => {
      if (numericPanelId) {
        await replacePanelImageMutation.mutateAsync({
          panelId: numericPanelId,
          imageUrl: source.url,
        });
      } else {
        await createPanelFromImageMutation.mutateAsync({
          projectId,
          chapterPosition,
          sourceImageUrl: source.url,
          sourceImageWidth: source.width,
          sourceImageHeight: source.height,
          position: numericPanelPosition,
        });
      }
      showSuccessNotification({ message: 'Panel committed successfully!' });
      // Commit either replaced an existing panel's image or created a new
      // one. Invalidate the chapter (panels changed) and the shell (panel
      // counts / hasInProgress flags may shift).
      void utils.comics.getProjectShell.invalidate({ id: projectId });
      void utils.comics.getChapter.invalidate({
        projectId,
        chapterPosition,
      });
    },
    [
      numericPanelId,
      numericPanelPosition,
      projectId,
      chapterPosition,
      replacePanelImageMutation,
      createPanelFromImageMutation,
      utils,
    ]
  );

  const handleClose = useCallback(() => {
    // Land back on the same chapter the user was iterating in. The
    // chapter URL exists as soon as a chapter does, so this is safe even
    // when chapterPosition is 0 (the default).
    void router.push(`/comics/project/${projectId}/chapter/${chapterPosition}`);
  }, [router, projectId, chapterPosition]);

  // ── Mature handoff: build a "same page on civitai.red" URL with the
  //    workflow ID encoded so the red side resumes polling the same workflow.
  //    Same panel/source/target params are preserved so the editor opens
  //    pointing at the same panel.
  const buildSiteRestrictedUnlockUrl = useCallback(
    (info: { workflowId: string; width: number; height: number; prompt: string }) => {
      if (!redDomain) return null;
      const params = new URLSearchParams();
      params.set('chapter', String(chapterPosition));
      params.set('panelPosition', String(numericPanelPosition));
      if (numericPanelId != null) params.set('panelId', String(numericPanelId));
      if (typeof imageUrl === 'string') params.set('imageUrl', imageUrl);
      if (typeof width === 'string') params.set('width', width);
      if (typeof height === 'string') params.set('height', height);
      params.set('pendingWorkflow', info.workflowId);
      params.set('pendingWidth', String(info.width));
      params.set('pendingHeight', String(info.height));
      if (info.prompt) params.set('pendingPrompt', info.prompt);
      const url = `//${redDomain}/comics/project/${projectId}/iterate?${params.toString()}`;
      return syncAccount(url);
    },
    [
      redDomain,
      projectId,
      chapterPosition,
      numericPanelId,
      numericPanelPosition,
      imageUrl,
      width,
      height,
    ]
  );

  // ── Resume payload for the red-side landing: hand the editor the in-flight
  //    workflow it should pick up.
  const initialPendingWorkflow = useMemo(() => {
    if (typeof pendingWorkflow !== 'string' || !pendingWorkflow) return null;
    const w =
      typeof pendingWidth === 'string' ? parseInt(pendingWidth, 10) : initialSource?.width ?? 1024;
    const h =
      typeof pendingHeight === 'string'
        ? parseInt(pendingHeight, 10)
        : initialSource?.height ?? 1024;
    return {
      workflowId: pendingWorkflow,
      width: Number.isFinite(w) ? w : 1024,
      height: Number.isFinite(h) ? h : 1024,
      prompt: typeof pendingPrompt === 'string' ? pendingPrompt : undefined,
    };
  }, [pendingWorkflow, pendingWidth, pendingHeight, pendingPrompt, initialSource]);

  // ── Render props for comic-specific slots ──

  const renderInput = useCallback(
    (props: InputSlotProps) => (
      <MentionTextarea
        value={props.prompt}
        onChange={props.setPrompt}
        references={mentions}
        placeholder="Describe the scene or changes... Use @Name for references"
        rows={2}
        onKeyDown={props.onKeyDown}
      />
    ),
    [mentions]
  );

  const { isGreen } = useFeatureFlags();

  // Block iterative editing of NSFW panels on green domain. The shell query
  // doesn't carry panel data, so we look the source panel up in the chapter
  // it belongs to (we already have `chapterPosition` from the URL). Skip the
  // fetch entirely when there's no panelId on the URL — that's the
  // "iterate from a free-form image" case, no source panel to gate on.
  const sourcePanelGateNeeded =
    isGreen && numericPanelId != null && projectId > 0 && Number.isFinite(chapterPosition);
  const { data: sourceChapter, isLoading: isSourceChapterLoading } =
    trpc.comics.getChapter.useQuery(
      { projectId, chapterPosition },
      { enabled: sourcePanelGateNeeded }
    );
  const sourcePanel =
    numericPanelId != null
      ? sourceChapter?.panels.find((p) => p.id === numericPanelId)
      : null;
  const isNsfwBlocked =
    isGreen &&
    !!sourcePanel?.image &&
    !hasSafeBrowsingLevel(sourcePanel.image.nsfwLevel);

  // Closes a brief leak window: on green, when a panelId is on the URL, we
  // need the chapter query to resolve before we can know whether the
  // source image is mature. Without this gate the editor would render with
  // `initialSource` (built from URL params) for the few hundred ms the
  // query takes — long enough to display a restricted image and feed it
  // back into a generation. We only block the *gate* path; if the chapter
  // happens to be cached, this resolves instantly.
  const isAwaitingNsfwGate = sourcePanelGateNeeded && isSourceChapterLoading;

  if (!project || isAwaitingNsfwGate) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text c="dimmed">Loading project...</Text>
      </div>
    );
  }

  if (isNsfwBlocked) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text c="dimmed">Mature content is not available on this site</Text>
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          padding: '12px 24px',
          borderBottom: '1px solid #373a40',
          borderImage: 'linear-gradient(90deg, #fab005, #fd7e14, transparent) 1',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
        }}
      >
        <Tooltip label="Back to project">
          <ActionIcon
            variant="subtle"
            component={Link}
            href={`/comics/project/${projectId}`}
          >
            <IconArrowLeft size={18} />
          </ActionIcon>
        </Tooltip>
        <IconMessages size={20} />
        <Title order={4}>
          Iterative Panel Editor
          {project.name && (
            <Text span c="dimmed" size="sm" ml={8}>
              — {project.name}
            </Text>
          )}
        </Title>
      </div>

      {/* Sketch Edit Warning */}
      <Alert
        variant="light"
        color="yellow"
        icon={<IconAlertTriangle size={16} />}
        mx="md"
        mt="sm"
        mb="xs"
      >
        <Text size="xs">
          Sketch Edit produces varying results depending on the model used. For best results, use{' '}
          <Text span fw={600}>
            Nano Banana
          </Text>
          .
        </Text>
      </Alert>

      {/* Editor */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <IterativeImageEditor
          initialSource={initialSource}
          config={config}
          onGenerate={handleGenerate}
          onPollStatus={handlePollStatus}
          onCommit={handleCommit}
          onClose={handleClose}
          renderInput={renderInput}
          projectReferences={activeReferences}
          costEstimate={iterateCostEstimate ?? null}
          isCostLoading={isCostFetching}
          enhanceCostEstimate={enhanceCostEstimate ?? null}
          enhanceInPlace={{
            projectId,
            chapterPosition,
            enhanceCost: enhanceCostEstimate?.cost ?? null,
            insertAtPosition: numericPanelPosition ?? undefined,
          }}
          onSettingsChange={handleSettingsChange}
          onRetryCost={handleRetryCost}
          buildSiteRestrictedUnlockUrl={buildSiteRestrictedUnlockUrl}
          initialPendingWorkflow={initialPendingWorkflow}
          mode="page"
        />
      </div>
    </div>
  );
}

export default Page(ComicIteratePage, {
  scrollable: false,
});
