import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  NumberInput,
  Select,
  Switch,
  Text,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconBolt,
  IconCheck,
  IconClock,
  IconMessages,
  IconPencil,
  IconPhotoPlus,
  IconRefresh,
  IconRestore,
  IconSend,
  IconUpload,
  IconUser,
  IconWand,
  IconZoomIn,
} from '@tabler/icons-react';
import type { WorkflowStepEvent } from '@civitai/client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import type { DrawingElement } from '~/components/Generation/Input/DrawingEditor/drawing.types';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { SignalMessages } from '~/server/common/enums';
import { showErrorNotification } from '~/utils/notifications';
import { openGeneratorImagePicker } from '~/utils/comic-image-picker';
import { getImageDimensions } from '~/utils/image-utils';

import { useComicsQueueStatus } from '~/components/Comics/hooks/useComicsQueueStatus';
import { AspectRatioSelector } from './AspectRatioSelector';
import { IterationMessage } from './IterationMessage';
import type {
  CharacterReference,
  CostEstimate,
  CostEstimateParams,
  ReferenceImage,
  IterativeEditorConfig,
  SourceImage,
  IterationEntry,
  GenerateParams,
  GenerateResult,
  PollParams,
  PollResult,
  InputSlotProps,
  SidebarSlotProps,
} from './iterative-editor.types';
import styles from './IterativeImageEditor.module.scss';

const DrawingEditorModal = dynamic(
  () =>
    import('~/components/Generation/Input/DrawingEditor/DrawingEditorModal').then(
      (mod) => mod.DrawingEditorModal
    ),
  { ssr: false }
);

const ImageSelectModal = dynamic(
  () => import('~/components/Training/Form/ImageSelectModal'),
  { ssr: false }
);

export interface IterativeImageEditorProps {
  initialSource?: SourceImage | null;
  config: IterativeEditorConfig;

  onGenerate: (params: GenerateParams) => Promise<GenerateResult>;
  onPollStatus: (params: PollParams) => Promise<PollResult>;
  onCommit?: (source: SourceImage) => Promise<void> | void;
  onClose?: () => void;

  /** Custom input area. Receives editor state + keyboard handler. Default: plain textarea. */
  renderInput?: (props: InputSlotProps) => React.ReactNode;
  /** Extra sidebar sections injected below the enhance toggle. */
  renderSidebarExtra?: (props: SidebarSlotProps) => React.ReactNode;

  /** All project references (characters/concepts). Editor computes which are @mentioned from the prompt. */
  projectReferences?: CharacterReference[];

  /** Dynamic generation cost from whatIf query. Overrides config.generationCost when ready. */
  costEstimate?: CostEstimate | null;
  /** True while the cost estimate query is fetching */
  isCostLoading?: boolean;
  /** Dynamic enhance cost from whatIf query. Overrides config.enhanceCost when ready. */
  enhanceCostEstimate?: CostEstimate | null;
  /** Called when editor settings change so the parent can update cost queries. */
  onSettingsChange?: (params: CostEstimateParams) => void;
  /** Called when user clicks retry after cost estimation failure. */
  onRetryCost?: () => void;

  mode?: 'page' | 'modal';
}

export function IterativeImageEditor({
  initialSource,
  config,
  onGenerate,
  onPollStatus,
  onCommit,
  onClose,
  renderInput,
  renderSidebarExtra,
  projectReferences,
  costEstimate,
  isCostLoading,
  enhanceCostEstimate,
  onSettingsChange,
  onRetryCost,
  mode = 'page',
}: IterativeImageEditorProps) {
  // ── Queue status ──
  const { canGenerate, available, used, limit, isLoading: queueLoading } = useComicsQueueStatus();
  const queueFull = available === 0 && !queueLoading;
  const generationDisabled = !canGenerate && available > 0 && !queueLoading;

  // ── Core state ──
  const [iterations, setIterations] = useState<IterationEntry[]>([]);
  const [currentSource, setCurrentSource] = useState<SourceImage | null>(
    initialSource ?? null
  );
  const [annotationElements, setAnnotationElements] = useState<DrawingElement[]>([]);
  const [originalSourceUrl, setOriginalSourceUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const isGeneratingRef = useRef(false);

  // Keep stable reference to initialSource for "Reset to original"
  const stableInitialSource = useRef(initialSource ?? null);

  // ── Controls state ──
  const [prompt, setPrompt] = useState('');
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [aspectRatio, setAspectRatio] = useState(config.defaultAspectRatio);
  const [generationModel, setGenerationModel] = useState<string | null>(null);
  const [selectedImageIds, setSelectedImageIds] = useState<number[] | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [userReferences, setUserReferences] = useState<ReferenceImage[]>([]);
  const [disabledRefUrls, setDisabledRefUrls] = useState<Set<string>>(new Set());
  const [uploadingCount, setUploadingCount] = useState(0);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  // Active (enabled) references only
  const activeUserReferences = useMemo(
    () => userReferences.filter((r) => !disabledRefUrls.has(r.url)),
    [userReferences, disabledRefUrls]
  );

  // Compute mentioned character references from prompt
  const mentionedCharacterRefs = useMemo(() => {
    if (!projectReferences?.length || !prompt.trim()) return [];
    const sorted = [...projectReferences].sort((a, b) => b.name.length - a.name.length);
    const mentioned = new Set<number>();
    for (const ref of sorted) {
      const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`@${escaped}(?=$|[\\s.,!?;:'")])`, 'gi');
      if (pattern.test(prompt)) mentioned.add(ref.id);
    }
    return projectReferences.filter((r) => mentioned.has(r.id));
  }, [projectReferences, prompt]);

  const { uploadToCF } = useCFImageUpload();
  const scrollRef = useRef<HTMLDivElement>(null);

  const effectiveModel = generationModel ?? config.defaultModel;
  const activeAspectRatios =
    config.modelSizes[effectiveModel] ?? config.modelSizes[config.defaultModel] ?? [];
  const maxReferenceImages = config.modelMaxImages[effectiveModel] ?? 7;

  // Count effective character images (selected or all if no selection)
  const allCharacterImageIds = useMemo(() => {
    const ids: number[] = [];
    for (const ref of mentionedCharacterRefs) {
      for (const ri of ref.images ?? []) {
        if (ri.image?.id) ids.push(ri.image.id);
      }
    }
    return ids;
  }, [mentionedCharacterRefs]);

  // Filter selectedImageIds to only include IDs from currently-mentioned characters.
  // This prevents stale selections from counting when @mentions are removed from the prompt.
  const activeSelectedImageIds = useMemo(() => {
    if (!selectedImageIds || allCharacterImageIds.length === 0) return null;
    const validIds = new Set(allCharacterImageIds);
    const filtered = selectedImageIds.filter((id) => validIds.has(id));
    return filtered.length > 0 ? filtered : null;
  }, [selectedImageIds, allCharacterImageIds]);

  // Notify parent when settings change so it can update cost queries
  useEffect(() => {
    // Extract reference IDs from @mentioned characters for server-side image fetch
    const mentionedRefIds = mentionedCharacterRefs.length > 0
      ? mentionedCharacterRefs.map((r) => r.id)
      : undefined;

    onSettingsChange?.({
      baseModel: generationModel,
      aspectRatio,
      quantity,
      sourceImage: currentSource
        ? { url: currentSource.url, width: currentSource.width, height: currentSource.height }
        : null,
      referenceImages: activeUserReferences.map((r) => ({
        url: r.url,
        width: r.width,
        height: r.height,
      })),
      referenceIds: mentionedRefIds,
      selectedImageIds: activeSelectedImageIds ?? undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generationModel, aspectRatio, quantity, currentSource, activeUserReferences, mentionedCharacterRefs, activeSelectedImageIds, onSettingsChange]);

  const effectiveCharacterImageCount = activeSelectedImageIds
    ? activeSelectedImageIds.length
    : allCharacterImageIds.length;

  const usedImageSlots =
    (currentSource ? 1 : 0) + activeUserReferences.length + effectiveCharacterImageCount;
  const remainingImageSlots = Math.max(0, maxReferenceImages - usedImageSlots);

  // ── Auto-scroll to bottom on new messages ──
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [iterations.length]);

  // ── Model change handler ──
  const handleModelChange = (value: string | null) => {
    setGenerationModel(value);
    const newSizes =
      config.modelSizes[value ?? config.defaultModel] ??
      config.modelSizes[config.defaultModel] ??
      [];
    if (!newSizes.some((s) => s.label === aspectRatio)) {
      const defaultLabel =
        newSizes.find(
          (s) => s.label === '3:4' || s.label === 'Portrait' || s.label === '2:3'
        )?.label ?? newSizes[0]?.label;
      if (defaultLabel) setAspectRatio(defaultLabel);
    }
  };

  // ── Workflow tracking for signal-based updates ──
  const activeWorkflowIdRef = useRef<string | null>(null);
  const activeIterationIdRef = useRef<string | null>(null);
  const activeDimsRef = useRef<{ width: number; height: number }>({ width: 512, height: 512 });
  const activePromptRef = useRef<string>('');

  const clearActiveWorkflow = useCallback(() => {
    activeWorkflowIdRef.current = null;
    activeIterationIdRef.current = null;
  }, []);

  const handlePollResult = useCallback(
    (result: PollResult, iterationId: string) => {
      if (result.status === 'succeeded' && result.imageUrl) {
        clearActiveWorkflow();
        const w = activeDimsRef.current.width;
        const h = activeDimsRef.current.height;

        // Build all result images
        const allImages: SourceImage[] = (result.images ?? []).map((img) => ({
          url: img.url,
          previewUrl: getEdgeUrl(img.url, { width: 400 }) ?? img.url,
          width: w,
          height: h,
        }));

        // Fallback: if images array is empty, use the single imageUrl
        if (allImages.length === 0) {
          allImages.push({
            url: result.imageUrl,
            previewUrl: getEdgeUrl(result.imageUrl, { width: 400 }) ?? result.imageUrl,
            width: w,
            height: h,
          });
        }

        const firstImage = allImages[0];
        setIterations((prev) =>
          prev.map((it) =>
            it.id === iterationId
              ? {
                  ...it,
                  status: 'ready' as const,
                  resultImage: firstImage,
                  resultImages: allImages,
                }
              : it
          )
        );
        setCurrentSource(firstImage);
        setAnnotationElements([]);
        setOriginalSourceUrl(null);
        setIsGenerating(false);
        isGeneratingRef.current = false;
      } else if (result.status === 'failed') {
        clearActiveWorkflow();
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
        isGeneratingRef.current = false;
      }
    },
    [clearActiveWorkflow]
  );

  const doPollOnce = useCallback(async () => {
    const workflowId = activeWorkflowIdRef.current;
    const iterationId = activeIterationIdRef.current;
    if (!workflowId || !iterationId) return;

    try {
      const result = await onPollStatus({
        workflowId,
        width: activeDimsRef.current.width,
        height: activeDimsRef.current.height,
        prompt: activePromptRef.current || undefined,
      });
      handlePollResult(result, iterationId);
    } catch {
      // Ignore poll errors — signal will retry
    }
  }, [onPollStatus, handlePollResult]);

  const startWorkflow = useCallback(
    (workflowId: string, iterationId: string, width: number, height: number, prompt: string) => {
      activeWorkflowIdRef.current = workflowId;
      activeIterationIdRef.current = iterationId;
      activeDimsRef.current = { width, height };
      activePromptRef.current = prompt;
    },
    []
  );

  // Signal-based updates: when orchestrator signals completion, poll to download image
  useSignalConnection(
    SignalMessages.TextToImageUpdate,
    useCallback(
      (data: Omit<WorkflowStepEvent, '$type'> & { $type: string }) => {
        if (data.$type !== 'step') return;
        if (!activeWorkflowIdRef.current || data.workflowId !== activeWorkflowIdRef.current)
          return;
        if (data.status === 'succeeded' || data.status === 'failed') {
          void doPollOnce();
        }
      },
      [doPollOnce]
    )
  );

  // ── Generation cost (whatIf only — no fallback) ──
  const costLoading = isCostLoading ?? false;
  const costFailed = !!costEstimate && !costEstimate.ready && !costLoading;
  const estimatedCost = useMemo(() => {
    if (!costEstimate?.ready) return null;
    const base = costEstimate.cost;
    const enhanceCost =
      enhanceCostEstimate?.ready && enhanceCostEstimate.cost > 0
        ? enhanceCostEstimate.cost
        : config.enhanceCost;
    const enhance = enhancePrompt && prompt.trim() ? enhanceCost : 0;
    return base + enhance;
  }, [costEstimate, enhanceCostEstimate, config.enhanceCost, enhancePrompt, prompt]);

  // ── Send / Generate handler ──
  const handleSend = async () => {
    if (!prompt.trim() || isGeneratingRef.current) return;

    isGeneratingRef.current = true;

    const iterationId = `iter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const hasAnnotations = annotationElements.length > 0;

    const newIteration: IterationEntry = {
      id: iterationId,
      prompt: prompt.trim(),
      annotated: hasAnnotations,
      sourceImage: currentSource,
      resultImage: null,
      resultImages: [],
      cost: estimatedCost ?? 0,
      timestamp: new Date(),
      status: 'generating',
    };

    setIterations((prev) => [...prev, newIteration]);
    setIsGenerating(true);

    const currentPrompt = prompt.trim();
    setPrompt('');

    try {
      const generateParams: GenerateParams = {
        prompt: currentPrompt,
        enhance: enhancePrompt,
        aspectRatio,
        baseModel: generationModel,
        quantity,
        ...(currentSource
          ? {
              sourceImageUrl: currentSource.url,
              sourceImageWidth: currentSource.width,
              sourceImageHeight: currentSource.height,
            }
          : {}),
        ...(activeSelectedImageIds ? { selectedImageIds: activeSelectedImageIds } : {}),
        ...(activeUserReferences.length > 0 ? { referenceImages: activeUserReferences } : {}),
      };

      const result = await onGenerate(generateParams);

      // Update iteration with actual cost and enhanced prompt from server
      if ((result.cost != null && result.cost !== estimatedCost) || result.enhancedPrompt) {
        setIterations((prev) =>
          prev.map((it) =>
            it.id === iterationId
              ? {
                  ...it,
                  ...(result.cost != null ? { cost: result.cost } : {}),
                  ...(result.enhancedPrompt ? { enhancedPrompt: result.enhancedPrompt } : {}),
                }
              : it
          )
        );
      }

      startWorkflow(result.workflowId, iterationId, result.width, result.height, currentPrompt);
    } catch (error) {
      showErrorNotification({ error: error as Error, title: 'Failed to generate' });
      setIsGenerating(false);
      isGeneratingRef.current = false;
      setIterations((prev) =>
        prev.map((it) =>
          it.status === 'generating'
            ? { ...it, status: 'error' as const, errorMessage: (error as Error).message }
            : it
        )
      );
    }
  };

  // ── Annotation handler ──
  const handleAnnotateSource = async () => {
    if (!currentSource) return;

    const cleanUrl = originalSourceUrl ?? currentSource.url;
    if (!originalSourceUrl) setOriginalSourceUrl(currentSource.url);

    const sourceUrl = cleanUrl.startsWith('http')
      ? cleanUrl
      : getEdgeUrl(cleanUrl, { original: true }) ?? cleanUrl;

    // Resolve actual image dimensions to ensure correct aspect ratio
    let imgWidth = currentSource.width;
    let imgHeight = currentSource.height;
    try {
      const dims = await getImageDimensions(sourceUrl);
      imgWidth = dims.width;
      imgHeight = dims.height;
    } catch {
      // Fall back to stored dimensions
    }

    dialogStore.trigger({
      component: DrawingEditorModal,
      props: {
        sourceImage: {
          url: sourceUrl,
          width: imgWidth,
          height: imgHeight,
        },
        initialLines: annotationElements,
        confirmLabel: 'Apply Annotations',
        onConfirm: async (blob: Blob, elements: DrawingElement[]) => {
          setAnnotationElements(elements);
          try {
            const file = new File([blob], 'annotated-source.jpg', { type: 'image/jpeg' });
            const result = await uploadToCF(file);
            const annotatedImage: SourceImage = {
              url: result.id,
              previewUrl: getEdgeUrl(result.id, { width: 400 }) ?? result.id,
              width: imgWidth,
              height: imgHeight,
            };
            setCurrentSource(annotatedImage);

            // Add an iteration entry so the annotation shows in the chat
            const iterationId = `annot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            setIterations((prev) => [
              ...prev,
              {
                id: iterationId,
                prompt: '(annotated)',
                annotated: true,
                sourceImage: currentSource,
                resultImage: annotatedImage,
                resultImages: [annotatedImage],
                cost: 0,
                timestamp: new Date(),
                status: 'ready' as const,
              },
            ]);
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

  // ── Pick a specific image from multi-image results ──
  const handleSelectImage = useCallback(
    (iterationId: string, image: SourceImage) => {
      setIterations((prev) =>
        prev.map((it) => (it.id === iterationId ? { ...it, resultImage: image } : it))
      );
      // If this iteration is the current source, update it
      setCurrentSource((prev) => {
        const iteration = iterations.find((it) => it.id === iterationId);
        if (!iteration) return prev;
        // Only auto-update if this iteration was already the current source
        if (prev && iteration.resultImage && prev.url === iteration.resultImage.url) {
          return image;
        }
        return prev;
      });
    },
    [iterations]
  );

  // ── Reset to original source ──
  const handleResetToOriginal = useCallback(() => {
    setCurrentSource(stableInitialSource.current);
    setAnnotationElements([]);
    setOriginalSourceUrl(null);
  }, []);

  const canResetToOriginal = useMemo(() => {
    if (!stableInitialSource.current) return false;
    if (!currentSource) return true;
    return currentSource.url !== stableInitialSource.current.url;
  }, [currentSource]);

  // ── User-imported reference images ──
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addUserReference = useCallback((ref: ReferenceImage) => {
    setUserReferences((prev) => [...prev, ref]);
  }, []);

  const removeUserReference = useCallback((url: string) => {
    setUserReferences((prev) => prev.filter((r) => r.url !== url));
    setDisabledRefUrls((prev) => {
      const next = new Set(prev);
      next.delete(url);
      return next;
    });
  }, []);

  const toggleUserReference = useCallback((url: string) => {
    setDisabledRefUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  // Upload reference image from PC
  const handleUploadReference = useCallback(
    async (file: File) => {
      setUploadingCount((c) => c + 1);
      try {
        const result = await uploadToCF(file);
        const objectUrl = URL.createObjectURL(file);
        const dims = await getImageDimensions(objectUrl);
        URL.revokeObjectURL(objectUrl);
        addUserReference({
          url: result.id,
          previewUrl: getEdgeUrl(result.id, { width: 100 }) ?? result.id,
          width: dims.width,
          height: dims.height,
        });
      } catch (err) {
        showErrorNotification({ error: err as Error, title: 'Failed to upload reference' });
      } finally {
        setUploadingCount((c) => Math.max(0, c - 1));
      }
    },
    [uploadToCF, addUserReference]
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files) {
        for (const file of Array.from(files)) {
          void handleUploadReference(file);
        }
      }
      e.target.value = '';
    },
    [handleUploadReference]
  );

  // Import reference from generator history
  const handleImportFromGenerator = useCallback(() => {
    openGeneratorImagePicker({
      title: 'Import Reference Images',
      fileNameBase: 'iterate-ref',
      uploadFn: uploadToCF,
      ImageSelectModal,
      maxSelections: 20,
      onLoadingChange: (loading) => setUploadingCount((c) => loading ? c + 1 : Math.max(0, c - 1)),
      onSuccess: async (cfId: string) => {
        const edgeUrl = getEdgeUrl(cfId, { width: 100 }) ?? cfId;
        const fullUrl = getEdgeUrl(cfId, { original: true }) ?? cfId;
        try {
          const dims = await getImageDimensions(fullUrl);
          addUserReference({
            url: cfId,
            previewUrl: edgeUrl,
            width: dims.width,
            height: dims.height,
          });
        } catch {
          addUserReference({
            url: cfId,
            previewUrl: edgeUrl,
            width: 1024,
            height: 1024,
          });
        }
      },
    });
  }, [uploadToCF, addUserReference]);

  // ── Commit ──
  const handleCommit = async () => {
    if (isGenerating || !currentSource) return;

    if (iterations.length === 0) {
      onClose?.();
      return;
    }

    try {
      await onCommit?.(currentSource);
    } catch {
      return;
    }

    onClose?.();
  };

  // ── Current source preview URL ──
  const currentSourcePreviewUrl = currentSource
    ? currentSource.previewUrl.startsWith('http')
      ? currentSource.previewUrl
      : getEdgeUrl(currentSource.previewUrl, { width: 400 }) ?? currentSource.previewUrl
    : null;

  // ── Close with confirmation ──
  const handleClose = useCallback(() => {
    if (iterations.length > 0) {
      openConfirmModal({
        title: 'Discard changes?',
        children: (
          <Text size="sm">You have uncommitted changes. Close without committing?</Text>
        ),
        labels: { confirm: 'Discard', cancel: 'Keep editing' },
        confirmProps: { color: 'red' },
        onConfirm: () => onClose?.(),
      });
    } else {
      onClose?.();
    }
  }, [iterations.length, onClose]);

  // ── Retry failed iteration ──
  const handleRetry = useCallback((iteration: IterationEntry) => {
    setCurrentSource(iteration.sourceImage);
    setPrompt(iteration.prompt);
    setIterations((prev) => prev.filter((it) => it.id !== iteration.id));
  }, []);

  // ── Keyboard shortcut: Ctrl/Cmd+Enter to send ──
  const sendButtonRef = useRef<HTMLDivElement>(null);
  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const btn = sendButtonRef.current?.querySelector('button');
        if (btn && !btn.disabled) btn.click();
      }
    },
    []
  );

  // ── Running total buzz spent ──
  const totalSpent = useMemo(
    () => iterations.reduce((sum, it) => sum + (it.status !== 'error' ? it.cost : 0), 0),
    [iterations]
  );

  const containerClass =
    mode === 'page' ? styles.editorContainerPage : styles.editorContainer;

  // ── Shared slot context ──
  const slotContext = useMemo(
    () => ({
      prompt,
      setPrompt,
      isGenerating,
      selectedImageIds,
      setSelectedImageIds,
      effectiveModel,
      maxReferenceImages,
    }),
    [prompt, isGenerating, selectedImageIds, effectiveModel, maxReferenceImages]
  );

  return (
    <div className={containerClass}>
      {/* ── Chat area (left) ── */}
      <div className={styles.chatArea}>
        {totalSpent > 0 && (
          <div className={styles.sessionTotalBar}>
            <IconBolt size={14} />
            <Text size="xs" fw={600}>
              Session total: {totalSpent} Buzz
            </Text>
          </div>
        )}
        <div className={styles.chatMessages} ref={scrollRef}>
          {iterations.length === 0 ? (
            <div className={styles.emptyState}>
              <IconMessages size={32} />
              <Text size="sm" c="dimmed">
                Describe your image to start generating.
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
                onSelectImage={(image) => handleSelectImage(iteration.id, image)}
                onRetry={
                  iteration.status === 'error' ? () => handleRetry(iteration) : undefined
                }
                onZoomImage={setLightboxUrl}
              />
            ))
          )}
        </div>

        {/* ── Queue / generation status warnings ── */}
        {queueFull && (
          <Alert color="red" icon={<IconClock size={16} />} mx="sm" mb={0}>
            Queue full ({used}/{limit} jobs). Wait for jobs to complete.
          </Alert>
        )}
        {generationDisabled && (
          <Alert color="red" icon={<IconClock size={16} />} mx="sm" mb={0}>
            Image generation is currently unavailable. Please try again later.
          </Alert>
        )}

        {/* ── Input area ── */}
        <div className={styles.inputArea}>
          {renderInput ? (
            renderInput({ ...slotContext, onKeyDown: handleTextareaKeyDown })
          ) : (
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleTextareaKeyDown}
              placeholder="Describe your image or changes..."
              rows={2}
              style={{
                width: '100%',
                background: 'var(--mantine-color-body)',
                border: '1px solid var(--mantine-color-default-border)',
                borderRadius: 'var(--mantine-radius-sm)',
                padding: '8px 12px',
                fontSize: 14,
                color: 'var(--mantine-color-text)',
                fontFamily: 'inherit',
                resize: 'vertical',
                outline: 'none',
              }}
            />
          )}
          <div className={styles.inputActions}>
            <div className={styles.inputActionsLeft}>
            </div>
            <div className="flex items-center gap-1">
              {costFailed && onRetryCost && (
                <Tooltip label="Retry cost calculation" withArrow position="top">
                  <Button
                    variant="light"
                    color="red"
                    size="compact-sm"
                    onClick={onRetryCost}
                    px={6}
                  >
                    <IconRefresh size={14} />
                  </Button>
                </Tooltip>
              )}
              <Tooltip
                label={
                  queueFull
                    ? `Queue full (${used}/${limit})`
                    : generationDisabled
                      ? 'Generation unavailable'
                      : costFailed
                        ? 'Cost estimation failed'
                        : costLoading || estimatedCost == null
                          ? 'Calculating cost…'
                          : `~${estimatedCost} Buzz (Ctrl+Enter)`
                }
                withArrow
                position="top"
              >
                <div ref={sendButtonRef}>
                  <BuzzTransactionButton
                    buzzAmount={estimatedCost ?? 0}
                    error={costFailed ? 'Cost estimation failed — click retry' : undefined}
                    label={
                      <span className="flex items-center gap-1">
                        <IconSend size={14} />
                        {currentSource ? 'Refine' : 'Generate'}
                      </span>
                    }
                    loading={isGenerating || (costLoading && !costFailed)}
                    disabled={!prompt.trim() || isGenerating || estimatedCost == null || queueFull || generationDisabled}
                    onPerformTransaction={handleSend}
                    showPurchaseModal
                    size="compact-sm"
                  />
                </div>
              </Tooltip>
            </div>
          </div>
        </div>
      </div>

      {/* ── Controls sidebar (right) ── */}
      <div className={styles.controlsSidebar}>
        <div className={styles.sidebarScrollable}>
        {/* Current source preview */}
        <div className={styles.sidebarSection}>
          <div className={styles.sidebarSectionTitle}>Current Source</div>
          {currentSourcePreviewUrl ? (
            <div
              className={styles.currentSourcePreview}
              style={{ cursor: 'pointer' }}
              onClick={() =>
                setLightboxUrl(
                  currentSource
                    ? getEdgeUrl(currentSource.url, { width: 1200 }) ?? currentSourcePreviewUrl
                    : currentSourcePreviewUrl
                )
              }
              role="button"
              tabIndex={0}
            >
              <img src={currentSourcePreviewUrl} alt="Current source" />
            </div>
          ) : (
            <div className={styles.noSourcePlaceholder}>
              <IconPhotoPlus size={28} style={{ opacity: 0.5 }} />
              <Text size="xs" c="dimmed" ta="center">
                No source image
              </Text>
              <Text size="xs" c="dimmed" ta="center" style={{ opacity: 0.6 }}>
                First generation will create from prompt
              </Text>
            </div>
          )}
          {canResetToOriginal && (
            <Button
              variant="subtle"
              size="compact-xs"
              leftSection={<IconRestore size={14} />}
              onClick={handleResetToOriginal}
              disabled={isGenerating}
              mt={4}
              fullWidth
            >
              Reset to original
            </Button>
          )}
          <Group gap="xs" mt={4}>
            {currentSource && (
              <Tooltip label="Annotate / sketch on the source image">
                <Button
                  variant="light"
                  size="compact-xs"
                  leftSection={<IconPencil size={14} />}
                  onClick={handleAnnotateSource}
                  disabled={isGenerating}
                  flex={1}
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
          </Group>
        </div>

        {/* Model selector */}
        <div className={styles.sidebarSection}>
          <Select
            label="Model"
            data={config.modelOptions}
            value={effectiveModel}
            onChange={handleModelChange}
            size="xs"
          />
          <Text size="xs" c={remainingImageSlots === 0 ? 'yellow' : 'dimmed'}>
            {usedImageSlots}/{maxReferenceImages} image slots used
            {remainingImageSlots === 0 ? ' (max)' : ''}
          </Text>
        </div>

        {/* Aspect ratio */}
        <div className={styles.sidebarSection}>
          <AspectRatioSelector
            value={aspectRatio}
            onChange={setAspectRatio}
            aspectRatios={activeAspectRatios}
          />
        </div>

        {/* Reference images — unified section for characters + uploads */}
        <div className={styles.sidebarSection}>
          <div className={styles.sidebarSectionTitle}>
            References
          </div>

          {/* Scrollable container for reference thumbnails */}
          <div className={styles.sidebarSectionScrollable}>
          {/* Character reference images from @mentions — grouped by character */}
          {mentionedCharacterRefs.map((charRef) => {
            const images = (charRef.images ?? []) as { image: { id: number; url: string } }[];
            if (images.length === 0) return null;
            const effectiveIds = selectedImageIds ?? allCharacterImageIds;
            return (
              <div key={charRef.id}>
                <Text size="xs" fw={600} c="dimmed" mb={2}>
                  <IconUser size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} />
                  {charRef.name}
                </Text>
                <div className="flex flex-wrap gap-1">
                  {images.map((ri) => {
                    const checked = effectiveIds.includes(ri.image.id);
                    return (
                      <div
                        key={ri.image.id}
                        className={styles.refThumb}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          const current = selectedImageIds ?? [...allCharacterImageIds];
                          if (checked) {
                            if (current.length <= 1) return;
                            setSelectedImageIds(current.filter((id) => id !== ri.image.id));
                          } else {
                            setSelectedImageIds([...current, ri.image.id]);
                          }
                        }}
                        style={{
                          position: 'relative',
                          width: 48,
                          height: 48,
                          borderRadius: 6,
                          overflow: 'hidden',
                          border: checked
                            ? '2px solid var(--mantine-color-yellow-5)'
                            : '1px solid var(--mantine-color-default-border)',
                          opacity: checked ? 1 : 0.4,
                          cursor: 'pointer',
                          transition: 'opacity 0.15s, border 0.15s',
                        }}
                      >
                        <img
                          src={getEdgeUrl(ri.image.url, { width: 100 }) ?? ri.image.url}
                          alt={charRef.name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                        <button
                          type="button"
                          className={styles.zoomButton}
                          onClick={(e) => {
                            e.stopPropagation();
                            setLightboxUrl(getEdgeUrl(ri.image.url, { width: 1200 }) ?? ri.image.url);
                          }}
                        >
                          <IconZoomIn size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* User-uploaded references */}
          {(userReferences.length > 0 || uploadingCount > 0) && (
            <>
              {mentionedCharacterRefs.length > 0 && (
                <Text size="xs" fw={600} c="dimmed" mb={2}>
                  <IconUpload size={10} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 3 }} />
                  Uploaded
                </Text>
              )}
              <div className="flex flex-wrap gap-1">
                {userReferences.map((ref) => {
                  const isDisabled = disabledRefUrls.has(ref.url);
                  return (
                    <div
                      key={ref.url}
                      className={styles.refThumb}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleUserReference(ref.url)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleUserReference(ref.url);
                        }
                      }}
                      style={{
                        position: 'relative',
                        width: 48,
                        height: 48,
                        borderRadius: 6,
                        overflow: 'hidden',
                        border: isDisabled
                          ? '1px solid var(--mantine-color-default-border)'
                          : '2px solid var(--mantine-color-blue-filled)',
                        opacity: isDisabled ? 0.4 : 1,
                        cursor: 'pointer',
                        transition: 'opacity 0.15s, border 0.15s',
                      }}
                    >
                      <img
                        src={ref.previewUrl}
                        alt="Reference"
                        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                      />
                      <button
                        type="button"
                        className={styles.zoomButton}
                        onClick={(e) => {
                          e.stopPropagation();
                          setLightboxUrl(getEdgeUrl(ref.url, { width: 1200 }) ?? ref.previewUrl);
                        }}
                      >
                        <IconZoomIn size={12} />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeUserReference(ref.url);
                        }}
                        style={{
                          position: 'absolute',
                          top: 1,
                          right: 1,
                          width: 16,
                          height: 16,
                          borderRadius: '50%',
                          background: 'rgba(0,0,0,0.7)',
                          color: '#fff',
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          lineHeight: 1,
                          padding: 0,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                {/* Upload loading placeholders */}
                {Array.from({ length: uploadingCount }).map((_, i) => (
                  <div
                    key={`uploading-${i}`}
                    style={{
                      width: 48,
                      height: 48,
                      borderRadius: 6,
                      border: '1px dashed var(--mantine-color-default-border)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'var(--mantine-color-dark-6)',
                    }}
                  >
                    <Loader size={16} color="gray" />
                  </div>
                ))}
              </div>
            </>
          )}

          </div>
          <div className="flex gap-1">
            <Button
              variant="light"
              size="compact-xs"
              leftSection={<IconUpload size={12} />}
              onClick={() => fileInputRef.current?.click()}
              disabled={isGenerating}
            >
              Upload
            </Button>
            <Button
              variant="light"
              size="compact-xs"
              leftSection={<IconWand size={12} />}
              onClick={handleImportFromGenerator}
              disabled={isGenerating}
            >
              Generator
            </Button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileInputChange}
          />
        </div>

        {/* Quantity selector */}
        <div className={styles.sidebarSection}>
          <NumberInput
            label="Images per generation"
            value={quantity}
            onChange={(val) => setQuantity(typeof val === 'number' ? Math.max(1, Math.min(4, val)) : 1)}
            min={1}
            max={4}
            size="xs"
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

        {/* Plugin sidebar sections */}
        {renderSidebarExtra?.(slotContext)}

        {/* Cost info */}
        <Text size="xs" c={costFailed ? 'red' : 'dimmed'}>
          {costFailed
            ? 'Cost estimation failed'
            : costLoading || estimatedCost == null
              ? 'Calculating cost…'
              : `~${estimatedCost} Buzz per generation`}
        </Text>

        </div>{/* end sidebarScrollable */}

        {/* Commit button */}
        <div className={styles.commitSection}>
          <button
            className={styles.commitButton}
            disabled={isGenerating || !iterations.some((it) => it.status === 'ready')}
            onClick={handleCommit}
          >
            <IconCheck size={16} />
            {config.commitLabel ?? 'Save Image'}
          </button>
        </div>
      </div>

      {/* Lightbox overlay */}
      {lightboxUrl && (
        <div
          className={styles.lightboxOverlay}
          onClick={() => setLightboxUrl(null)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setLightboxUrl(null);
          }}
        >
          <img
            src={lightboxUrl}
            alt="Preview"
            className={styles.lightboxImage}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
