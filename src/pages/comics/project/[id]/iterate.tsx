import { ActionIcon, Text, Title, Tooltip } from '@mantine/core';
import { IconArrowLeft, IconMessages, IconUser } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import {
  COMIC_MODEL_MAX_IMAGES,
  COMIC_MODEL_OPTIONS,
  COMIC_MODEL_SIZES,
} from '~/components/Comics/comic-project-constants';
import { ImageSelectionSection } from '~/components/Comics/ImageSelectionSection';
import { MentionTextarea } from '~/components/Comics/MentionTextarea';
import { IterativeImageEditor } from '~/components/IterativeEditor/IterativeImageEditor';
import type {
  CostEstimateParams,
  GenerateParams,
  InputSlotProps,
  IterativeEditorConfig,
  PollParams,
  SidebarSlotProps,
  SourceImage,
} from '~/components/IterativeEditor/iterative-editor.types';
import { Page } from '~/components/AppLayout/Page';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import styles from './ProjectWorkspace.module.scss';

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
  const currentUser = useCurrentUser();
  const { id, panelId, panelPosition, imageUrl, width, height, chapter } = router.query;
  const projectId = Number(id);
  const chapterPosition = Number(chapter) || 0;
  const numericPanelId = panelId ? Number(panelId) : null;
  const numericPanelPosition = Number(panelPosition) || 0;

  // ── Fetch project data for references + cost ──
  const { data: project } = trpc.comics.getProject.useQuery(
    { id: projectId },
    { enabled: !!projectId && !isNaN(projectId) }
  );

  // ── Dynamic whatIf cost estimation ──
  const [costParams, setCostParams] = useState<CostEstimateParams>({
    baseModel: project?.baseModel ?? DEFAULT_MODEL,
    aspectRatio: '3:4',
    quantity: 1,
    hasSourceImage: false,
  });

  const {
    data: iterateCostEstimate,
    isFetching: isCostFetching,
    refetch: refetchCost,
  } = trpc.comics.getIterateCostEstimate.useQuery(
    {
      baseModel: costParams.baseModel,
      aspectRatio: costParams.aspectRatio,
      quantity: costParams.quantity,
      hasSourceImage: costParams.hasSourceImage,
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
        enhance: params.enhance,
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
      });
    },
    [iterateGenerateMutation, projectId, chapterPosition]
  );

  const handlePollStatus = useCallback(
    async (params: PollParams) => {
      return utils.comics.pollIterationStatus.fetch(params);
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
      void utils.comics.getProject.invalidate({ id: projectId });
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
    void router.push(`/comics/project/${projectId}`);
  }, [router, projectId]);

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

  const renderSidebarExtra = useCallback(
    (props: SidebarSlotProps) => {
      // Detect mentioned references from prompt
      const mentionedRefs = getMentionedReferences(props.prompt, activeReferences);
      const refImageCount = mentionedRefs.reduce(
        (sum: number, c: any) => sum + (c.images?.length ?? 0),
        0
      );
      const needsSelection = mentionedRefs.length > 0 && refImageCount > props.maxReferenceImages;

      return (
        <>
          {needsSelection && (
            <div className={styles.sidebarSection ?? ''}>
              <ImageSelectionSection
                mentionedReferences={mentionedRefs}
                selectedImageIds={props.selectedImageIds}
                setSelectedImageIds={props.setSelectedImageIds}
                refImageBudget={props.maxReferenceImages}
              />
            </div>
          )}
          {mentionedRefs.length > 0 && (
            <div className={styles.sidebarSection ?? ''}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--mantine-color-dimmed)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}
              >
                References
              </div>
              <div className="flex flex-wrap gap-1">
                {mentionedRefs.map((ref: any) => (
                  <span
                    key={ref.id}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      background: '#339af0',
                      color: '#fff',
                      padding: '3px 10px',
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    <IconUser size={12} />
                    {ref.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      );
    },
    [activeReferences]
  );

  if (!project) {
    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Text c="dimmed">Loading project...</Text>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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
          renderSidebarExtra={renderSidebarExtra}
          costEstimate={iterateCostEstimate ?? null}
          isCostLoading={isCostFetching}
          enhanceCostEstimate={enhanceCostEstimate ?? null}
          onSettingsChange={handleSettingsChange}
          onRetryCost={handleRetryCost}
          mode="page"
        />
      </div>
    </div>
  );
}

/** Extract mentioned references from prompt text */
function getMentionedReferences(prompt: string, references: any[]): any[] {
  if (!prompt.trim() || references.length === 0) return [];
  const sorted = [...references].sort((a: any, b: any) => b.name.length - a.name.length);
  const mentioned = new Set<number>();
  for (const ref of sorted) {
    const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`@${escaped}(?=$|[\\s.,!?;:'")])`, 'gi');
    if (pattern.test(prompt)) {
      mentioned.add(ref.id);
    }
  }
  return references.filter((r: any) => mentioned.has(r.id));
}

export default Page(ComicIteratePage, {
  scrollable: false,
  header: null,
  footer: null,
});
