import {
  Badge,
  Button,
  Modal,
  Select,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconCheck,
  IconMessages,
  IconPencil,
  IconPhoto,
  IconSend,
  IconUser,
} from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import type { DrawingElement } from '~/components/Generation/Input/DrawingEditor/drawing.types';
import { AspectRatioSelector } from '~/components/Comics/AspectRatioSelector';
import {
  COMIC_MODEL_MAX_IMAGES,
  COMIC_MODEL_OPTIONS,
  COMIC_MODEL_SIZES,
} from '~/components/Comics/comic-project-constants';
import { ImageSelectionSection } from '~/components/Comics/ImageSelectionSection';
import { MentionTextarea } from '~/components/Comics/MentionTextarea';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

import { IterationMessage } from './IterationMessage';
import type { IterationEntry, SourceImage } from './IterationMessage';
import styles from './IterativePanelEditor.module.scss';

const DrawingEditorModal = dynamic(
  () =>
    import('~/components/Generation/Input/DrawingEditor/DrawingEditorModal').then(
      (mod) => mod.DrawingEditorModal
    ),
  { ssr: false }
);

interface IterativePanelEditorProps {
  opened: boolean;
  onClose: () => void;
  projectId: number;
  chapterPosition: number;
  panelId: number | null;
  panelPosition: number;
  initialSource: SourceImage | null;
  allReferences: any[];
  activeReferences: any[];
  panelCost: number;
  enhanceCost: number;
  refetch: () => void;
  baseModel?: string;
}

export function IterativePanelEditor({
  opened,
  onClose,
  projectId,
  chapterPosition,
  panelId,
  panelPosition,
  initialSource,
  allReferences,
  activeReferences,
  panelCost,
  enhanceCost,
  refetch,
  baseModel,
}: IterativePanelEditorProps) {
  // ── Core state ──
  const [iterations, setIterations] = useState<IterationEntry[]>([]);
  const [currentSource, setCurrentSource] = useState<SourceImage | null>(initialSource);
  const [annotationElements, setAnnotationElements] = useState<DrawingElement[]>([]);
  const [originalSourceUrl, setOriginalSourceUrl] = useState<string | null>(null);
  const [stagingPanelId, setStagingPanelId] = useState<number | null>(panelId);
  const [isGenerating, setIsGenerating] = useState(false);

  // ── Controls state ──
  const [prompt, setPrompt] = useState('');
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [aspectRatio, setAspectRatio] = useState('3:4');
  type ComicModel = 'NanoBanana' | 'Flux2' | 'Seedream' | 'OpenAI' | 'Qwen' | 'Grok';
  const [generationModel, setGenerationModel] = useState<ComicModel | null>(null);
  const [selectedImageIds, setSelectedImageIds] = useState<number[] | null>(null);

  const { uploadToCF } = useCFImageUpload();
  const scrollRef = useRef<HTMLDivElement>(null);
  const utils = trpc.useUtils();

  const effectiveModel = generationModel ?? baseModel ?? 'NanoBanana';
  const activeAspectRatios = COMIC_MODEL_SIZES[effectiveModel] ?? COMIC_MODEL_SIZES.NanoBanana;
  const maxReferenceImages = COMIC_MODEL_MAX_IMAGES[effectiveModel] ?? 7;

  // ── Reset when modal opens with new props ──
  useEffect(() => {
    if (opened) {
      setIterations([]);
      setCurrentSource(initialSource);
      setAnnotationElements([]);
      setOriginalSourceUrl(null);
      setStagingPanelId(panelId);
      setIsGenerating(false);
      setPrompt('');
      setSelectedImageIds(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  // ── Reference mentions ──
  const mentionRefs = useMemo(
    () => activeReferences.map((c: any) => ({ id: c.id, name: c.name })),
    [activeReferences]
  );

  const mentionedReferences = useMemo(() => {
    if (!prompt.trim()) return [];
    const sorted = [...activeReferences].sort(
      (a: any, b: any) => b.name.length - a.name.length
    );
    const mentioned = new Set<number>();
    for (const ref of sorted) {
      const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`@${escaped}(?=$|[\\s.,!?;:'")])`, 'gi');
      if (pattern.test(prompt)) {
        mentioned.add(ref.id);
      }
    }
    return activeReferences.filter((r: any) => mentioned.has(r.id));
  }, [prompt, activeReferences]);

  const mentionedRefImageCount = useMemo(
    () => mentionedReferences.reduce((sum: number, c: any) => sum + (c.images?.length ?? 0), 0),
    [mentionedReferences]
  );

  const needsImageSelection = mentionedReferences.length > 0 && mentionedRefImageCount > maxReferenceImages;

  // ── Auto-scroll to bottom on new messages ──
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [iterations.length]);

  // ── Model change handler ──
  const handleModelChange = (value: string | null) => {
    setGenerationModel(value as ComicModel | null);
    const newSizes =
      COMIC_MODEL_SIZES[value ?? baseModel ?? 'NanoBanana'] ?? COMIC_MODEL_SIZES.NanoBanana;
    if (!newSizes.some((s) => s.label === aspectRatio)) {
      const defaultLabel =
        newSizes.find((s) => s.label === '3:4' || s.label === 'Portrait' || s.label === '2:3')
          ?.label ?? newSizes[0].label;
      setAspectRatio(defaultLabel);
    }
  };

  // ── Mutations ──
  const createPanelMutation = trpc.comics.createPanel.useMutation({
    onError: (error) => {
      showErrorNotification({ error, title: 'Failed to create panel' });
      setIsGenerating(false);
      // Mark current generating iteration as error
      setIterations((prev) =>
        prev.map((it) =>
          it.status === 'generating'
            ? { ...it, status: 'error' as const, errorMessage: error.message }
            : it
        )
      );
    },
  });

  const enhancePanelMutation = trpc.comics.enhancePanel.useMutation({
    onError: (error) => {
      showErrorNotification({ error, title: 'Failed to enhance panel' });
      setIsGenerating(false);
      setIterations((prev) =>
        prev.map((it) =>
          it.status === 'generating'
            ? { ...it, status: 'error' as const, errorMessage: error.message }
            : it
        )
      );
    },
  });

  const replacePanelImageMutation = trpc.comics.replacePanelImage.useMutation({
    onError: (error) => {
      showErrorNotification({ error, title: 'Failed to commit panel image' });
    },
  });

  // ── Polling for panel status ──
  const pollingIdRef = useRef<number | null>(null);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    pollingIdRef.current = null;
  }, []);

  const startPolling = useCallback(
    (panelIdToPoll: number, iterationId: string) => {
      stopPolling();
      pollingIdRef.current = panelIdToPoll;

      pollingIntervalRef.current = setInterval(async () => {
        try {
          const result = await utils.comics.pollPanelStatus.fetch({ panelId: panelIdToPoll });

          if (result.status === 'Ready' && result.imageUrl) {
            stopPolling();
            const previewUrl = getEdgeUrl(result.imageUrl, { width: 400 }) ?? result.imageUrl;
            // Poll returns { id, status, imageUrl } — use aspect ratio dimensions as fallback
            const arDims = activeAspectRatios.find((ar) => ar.label === aspectRatio) ?? activeAspectRatios[0];
            const newSource: SourceImage = {
              url: result.imageUrl,
              previewUrl,
              width: arDims?.width ?? 512,
              height: arDims?.height ?? 512,
            };
            setIterations((prev) =>
              prev.map((it) =>
                it.id === iterationId
                  ? { ...it, status: 'ready' as const, resultImage: newSource }
                  : it
              )
            );
            setCurrentSource(newSource);
            setAnnotationElements([]);
            setOriginalSourceUrl(null);
            setIsGenerating(false);
            // Refresh the project so the workspace sees the new panel
            refetch();
          } else if (result.status === 'Failed') {
            stopPolling();
            setIterations((prev) =>
              prev.map((it) =>
                it.id === iterationId
                  ? {
                      ...it,
                      status: 'error' as const,
                      errorMessage: 'Generation failed. Buzz has been refunded.',
                    }
                  : it
              )
            );
            setIsGenerating(false);
            refetch();
          }
        } catch {
          // Ignore poll errors, keep trying
        }
      }, 1500);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stopPolling, utils, refetch, activeAspectRatios, aspectRatio]
  );

  // Cleanup polling on unmount
  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // ── Generation cost ──
  const generationCost = panelCost + (enhancePrompt && prompt.trim() ? enhanceCost : 0);

  // ── Send / Generate handler ──
  const handleSend = async () => {
    if (!prompt.trim() || isGenerating) return;

    const iterationId = `iter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const hasAnnotations = annotationElements.length > 0;

    const newIteration: IterationEntry = {
      id: iterationId,
      prompt: prompt.trim(),
      annotated: hasAnnotations,
      sourceImage: currentSource,
      resultImage: null,
      cost: generationCost,
      timestamp: new Date(),
      status: 'generating',
    };

    setIterations((prev) => [...prev, newIteration]);
    setIsGenerating(true);

    const currentPrompt = prompt.trim();
    setPrompt('');

    try {
      if (!currentSource) {
        // First generation: txt2img via createPanel
        const result = await createPanelMutation.mutateAsync({
          projectId,
          chapterPosition,
          prompt: currentPrompt,
          enhance: enhancePrompt,
          useContext: false,
          includePreviousImage: false,
          aspectRatio,
          baseModel: generationModel,
          position: panelPosition,
          ...(selectedImageIds ? { selectedImageIds } : {}),
        });

        const newPanelId = result.id;
        setStagingPanelId(newPanelId);
        startPolling(newPanelId, iterationId);
        refetch();
      } else {
        // Subsequent: img2img via enhancePanel
        const result = await enhancePanelMutation.mutateAsync({
          projectId,
          chapterPosition,
          sourceImageUrl: currentSource.url,
          sourceImageWidth: currentSource.width,
          sourceImageHeight: currentSource.height,
          prompt: currentPrompt || undefined,
          enhance: enhancePrompt,
          useContext: false,
          includePreviousImage: false,
          aspectRatio,
          baseModel: generationModel,
          forceGenerate: true,
          position: panelPosition,
          ...(selectedImageIds ? { selectedImageIds } : {}),
        });

        const newPanelId = result.id;
        setStagingPanelId(newPanelId);
        startPolling(newPanelId, iterationId);
        refetch();
      }
    } catch {
      // Error already handled by mutation callbacks
    }
  };

  // ── Annotation handler ──
  const handleAnnotateSource = () => {
    if (!currentSource) return;

    const cleanUrl = originalSourceUrl ?? currentSource.url;
    if (!originalSourceUrl) setOriginalSourceUrl(currentSource.url);

    const sourceUrl = cleanUrl.startsWith('http')
      ? cleanUrl
      : getEdgeUrl(cleanUrl, { original: true }) ?? cleanUrl;

    dialogStore.trigger({
      component: DrawingEditorModal,
      props: {
        sourceImage: {
          url: sourceUrl,
          width: currentSource.width,
          height: currentSource.height,
        },
        initialLines: annotationElements,
        confirmLabel: 'Apply Annotations',
        onConfirm: async (blob: Blob, elements: DrawingElement[]) => {
          setAnnotationElements(elements);
          try {
            const file = new File([blob], 'annotated-source.jpg', { type: 'image/jpeg' });
            const result = await uploadToCF(file);
            setCurrentSource({
              url: result.id,
              previewUrl: getEdgeUrl(result.id, { width: 400 }) ?? result.id,
              width: currentSource.width,
              height: currentSource.height,
            });
          } catch (err) {
            showErrorNotification({
              error: err as Error,
              title: 'Failed to save annotation',
            });
          }
        },
      },
    });
  };

  // ── Revert: use a previous iteration as source ──
  const handleUseAsSource = (iteration: IterationEntry) => {
    if (!iteration.resultImage) return;
    setCurrentSource(iteration.resultImage);
    setAnnotationElements([]);
    setOriginalSourceUrl(null);
  };

  // ── Commit to panel ──
  const handleCommit = async () => {
    if (isGenerating) return;

    // If no iterations happened, just close
    if (iterations.length === 0) {
      onClose();
      return;
    }

    // Find the latest ready iteration to compare
    const latestReady = [...iterations].reverse().find((it) => it.status === 'ready');

    if (
      currentSource &&
      latestReady?.resultImage &&
      currentSource.url !== latestReady.resultImage.url &&
      stagingPanelId
    ) {
      // User reverted to an older image -- replace the panel image
      try {
        await replacePanelImageMutation.mutateAsync({
          panelId: stagingPanelId,
          imageUrl: currentSource.url,
        });
      } catch {
        // Error handled by mutation
        return;
      }
    }

    refetch();
    onClose();
  };

  // ── Current source preview URL ──
  const currentSourcePreviewUrl = currentSource
    ? currentSource.previewUrl.startsWith('http')
      ? currentSource.previewUrl
      : getEdgeUrl(currentSource.previewUrl, { width: 400 }) ?? currentSource.previewUrl
    : null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <IconMessages size={20} />
          <span>Iterative Panel Editor</span>
        </div>
      }
      size="90%"
      styles={{
        body: { padding: 0 },
        header: {
          borderBottom: '1px solid #373a40',
          borderImage: 'linear-gradient(90deg, #fab005, #fd7e14, transparent) 1',
        },
      }}
    >
      <div className={styles.editorContainer}>
        {/* ── Chat area (left) ── */}
        <div className={styles.chatArea}>
          <div className={styles.chatMessages} ref={scrollRef}>
            {iterations.length === 0 ? (
              <div className={styles.emptyState}>
                <IconMessages size={32} />
                <Text size="sm" c="dimmed">
                  Describe your panel to start generating.
                </Text>
                <Text size="xs" c="dimmed">
                  Each send produces a new image. You can refine iteratively.
                </Text>
              </div>
            ) : (
              iterations.map((iteration) => (
                <IterationMessage
                  key={iteration.id}
                  iteration={iteration}
                  isCurrentSource={
                    iteration.status === 'ready' &&
                    !!iteration.resultImage &&
                    !!currentSource &&
                    iteration.resultImage.url === currentSource.url
                  }
                  onUseAsSource={() => handleUseAsSource(iteration)}
                />
              ))
            )}
          </div>

          {/* ── Input area ── */}
          <div className={styles.inputArea}>
            <MentionTextarea
              value={prompt}
              onChange={setPrompt}
              references={mentionRefs}
              placeholder="Describe the scene or changes... Use @Name for references"
              rows={2}
            />
            <div className={styles.inputActions}>
              <div className={styles.inputActionsLeft}>
                {currentSource && (
                  <Tooltip label="Annotate current source image">
                    <Button
                      variant="light"
                      size="compact-sm"
                      leftSection={<IconPencil size={14} />}
                      onClick={handleAnnotateSource}
                      disabled={isGenerating}
                    >
                      Annotate
                    </Button>
                  </Tooltip>
                )}
                {annotationElements.length > 0 && (
                  <Badge size="sm" color="blue" variant="light">
                    <IconPencil size={10} style={{ marginRight: 4 }} />
                    Annotated
                  </Badge>
                )}
              </div>
              <Tooltip
                label={`Generation: ${panelCost} Buzz${enhancePrompt && prompt.trim() ? ` + Enhance: ${enhanceCost} Buzz` : ''}`}
                withArrow
                position="top"
              >
                <BuzzTransactionButton
                  buzzAmount={generationCost}
                  label={
                    <span className="flex items-center gap-1">
                      <IconSend size={14} />
                      {currentSource ? 'Refine' : 'Generate'}
                    </span>
                  }
                  loading={isGenerating}
                  disabled={!prompt.trim() || isGenerating}
                  onPerformTransaction={handleSend}
                  showPurchaseModal
                  size="compact-sm"
                />
              </Tooltip>
            </div>
          </div>
        </div>

        {/* ── Controls sidebar (right) ── */}
        <div className={styles.controlsSidebar}>
          {/* Current source preview */}
          <div className={styles.sidebarSection}>
            <div className={styles.sidebarSectionTitle}>Current Source</div>
            {currentSourcePreviewUrl ? (
              <div className={styles.currentSourcePreview}>
                <img src={currentSourcePreviewUrl} alt="Current source" />
              </div>
            ) : (
              <div className={styles.noSourcePlaceholder}>
                <IconPhoto size={24} />
                <Text size="xs" c="dimmed">
                  No source image yet
                </Text>
                <Text size="xs" c="dimmed">
                  First generation will use text-to-image
                </Text>
              </div>
            )}
          </div>

          {/* Model selector */}
          <div className={styles.sidebarSection}>
            <Select
              label="Model"
              data={COMIC_MODEL_OPTIONS}
              value={effectiveModel}
              onChange={handleModelChange}
              size="xs"
            />
          </div>

          {/* Aspect ratio */}
          <div className={styles.sidebarSection}>
            <AspectRatioSelector
              value={aspectRatio}
              onChange={setAspectRatio}
              aspectRatios={activeAspectRatios}
            />
          </div>

          {/* Enhance prompt toggle */}
          <Switch
            label="Enhance prompt"
            description="AI adds detail and composition"
            checked={enhancePrompt}
            onChange={(e) => setEnhancePrompt(e.currentTarget.checked)}
            color="yellow"
            size="sm"
          />

          {/* Image selection for references that exceed the budget */}
          {needsImageSelection && (
            <div className={styles.sidebarSection}>
              <ImageSelectionSection
                mentionedReferences={mentionedReferences}
                selectedImageIds={selectedImageIds}
                setSelectedImageIds={setSelectedImageIds}
                refImageBudget={maxReferenceImages}
              />
            </div>
          )}

          {/* Mentioned references display */}
          {mentionedReferences.length > 0 && (
            <div className={styles.sidebarSection}>
              <div className={styles.sidebarSectionTitle}>References</div>
              <div className="flex flex-wrap gap-1">
                {mentionedReferences.map((ref: any) => (
                  <span key={ref.id} className={styles.referencePill}>
                    <IconUser size={12} />
                    {ref.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Cost info */}
          <Text size="xs" c="dimmed">
            Each generation costs ~{generationCost} Buzz
          </Text>

          {/* Commit button */}
          <div className={styles.commitSection}>
            <button
              className={styles.commitButton}
              disabled={isGenerating || iterations.filter((it) => it.status === 'ready').length === 0}
              onClick={handleCommit}
            >
              <IconCheck size={16} />
              Commit to Panel
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
