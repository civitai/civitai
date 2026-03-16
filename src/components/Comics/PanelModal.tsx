import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import {
  IconInfoCircle,
  IconPencil,
  IconPhotoUp,
  IconPlus,
  IconPhoto,
  IconSparkles,
  IconUpload,
  IconWand,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext } from '@dnd-kit/sortable';

import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { DrawingEditorModal } from '~/components/Generation/Input/DrawingEditor/DrawingEditorModal';
import type { DrawingElement } from '~/components/Generation/Input/DrawingEditor/drawing.types';
import { AspectRatioSelector } from '~/components/Comics/AspectRatioSelector';
import {
  COMIC_MODEL_OPTIONS,
  type BulkPanelItem,
} from '~/components/Comics/comic-project-constants';
import { ImageSelectionSection } from '~/components/Comics/ImageSelectionSection';
import { MentionTextarea } from '~/components/Comics/MentionTextarea';
import { SortableBulkItem } from '~/components/Comics/SortableBulkItem';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { showErrorNotification } from '~/utils/notifications';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { fetchAndUploadGeneratorImage } from '~/utils/comic-image-picker';
import { trpc } from '~/utils/trpc';
import styles from '~/pages/comics/project/[id]/ProjectWorkspace.module.scss';

const ImageSelectModal = dynamic(() => import('~/components/Training/Form/ImageSelectModal'), {
  ssr: false,
});

interface PanelModalProps {
  opened: boolean;
  onClose: () => void;
  // Core state from parent
  prompt: string;
  setPrompt: (val: string) => void;
  enhancePrompt: boolean;
  setEnhancePrompt: (val: boolean) => void;
  useContext: boolean;
  setUseContext: (val: boolean) => void;
  includePreviousImage: boolean;
  setIncludePreviousImage: (val: boolean) => void;
  aspectRatio: string;
  setAspectRatio: (val: string) => void;
  selectedImageIds: number[] | null;
  setSelectedImageIds: (ids: number[] | null) => void;
  // Model
  effectiveModel: string;
  onModelChange: (value: string | null) => void;
  activeAspectRatios: { label: string; width: number; height: number }[];
  // References
  mentionRefs: { id: number; name: string }[];
  mentionedReferences: { id: number; name: string; type?: string; images?: any[] }[];
  needsImageSelection: boolean;
  refImageBudget: number;
  // Panel context
  regeneratingPanelId: number | null;
  insertAtPosition: number | null;
  activeChapterPanelCount: number;
  // Costs (null = still loading)
  panelCost: number | null;
  enhanceCost: number | null;
  // Submission
  isSubmitting: boolean;
  onGeneratePanel: () => void;
  onEnhancePanel: (sourceImage: {
    url: string;
    previewUrl: string;
    width: number;
    height: number;
  }) => void;
  onBulkCreate: (items: BulkPanelItem[], enhance: boolean) => void;
  onImportSubmit: (
    items: { url: string; cfId: string; width: number; height: number; preview: string }[]
  ) => void;
  // Loading states
  isCreatePending: boolean;
  isEnhancePending: boolean;
  isBulkPending: boolean;
  // Optional: pre-populate enhance tab from sketch edit
  initialEnhanceSource?: {
    url: string;
    previewUrl: string;
    width: number;
    height: number;
  } | null;
}

export function PanelModal({
  opened,
  onClose,
  prompt,
  setPrompt,
  enhancePrompt,
  setEnhancePrompt,
  useContext,
  setUseContext,
  includePreviousImage,
  setIncludePreviousImage,
  aspectRatio,
  setAspectRatio,
  selectedImageIds,
  setSelectedImageIds,
  effectiveModel,
  onModelChange,
  activeAspectRatios,
  mentionRefs,
  mentionedReferences,
  needsImageSelection,
  refImageBudget,
  regeneratingPanelId,
  insertAtPosition,
  activeChapterPanelCount,
  panelCost,
  enhanceCost,
  isSubmitting,
  onGeneratePanel,
  onEnhancePanel,
  onBulkCreate,
  onImportSubmit,
  isCreatePending,
  isEnhancePending,
  isBulkPending,
  initialEnhanceSource,
}: PanelModalProps) {
  const [panelMode, setPanelMode] = useState<'generate' | 'enhance' | 'bulk' | 'import'>(
    'generate'
  );

  // Enhance tab state
  const [enhanceSourceImage, setEnhanceSourceImage] = useState<{
    url: string;
    previewUrl: string;
    width: number;
    height: number;
  } | null>(null);
  const [enhanceUploading, setEnhanceUploading] = useState(false);
  // Persists drawing elements so the user can re-open the editor and continue annotating
  const [annotationElements, setAnnotationElements] = useState<DrawingElement[]>([]);
  // The original (clean, un-annotated) source URL for re-opening the editor
  const [originalSourceUrl, setOriginalSourceUrl] = useState<string | null>(null);
  const {
    uploadToCF: uploadEnhanceToCF,
    resetFiles: resetEnhanceFiles,
  } = useCFImageUpload();

  // Enhance tab cost — uses the actual source image for accurate img2img pricing
  const { data: enhanceImgCost } = trpc.comics.getIterateCostEstimate.useQuery(
    {
      baseModel: effectiveModel,
      aspectRatio,
      quantity: 1,
      sourceImage: enhanceSourceImage
        ? { url: enhanceSourceImage.url, width: enhanceSourceImage.width, height: enhanceSourceImage.height }
        : undefined,
    },
    { enabled: !!enhanceSourceImage, staleTime: 30_000, retry: 2 }
  );
  const enhanceGenCost = enhanceSourceImage ? (enhanceImgCost?.cost ?? null) : panelCost;

  // Bulk tab state
  const [bulkItems, setBulkItems] = useState<BulkPanelItem[]>([]);
  const [bulkEnhance, setBulkEnhance] = useState(true);
  const [bulkUploading, setBulkUploading] = useState(false);
  const { uploadToCF: uploadBulkToCF, resetFiles: resetBulkFiles } = useCFImageUpload();

  // Import tab state
  const [importUploading, setImportUploading] = useState(false);
  const [importSelected, setImportSelected] = useState<
    { url: string; cfId: string; width: number; height: number; preview: string }[]
  >([]);
  const { uploadToCF: uploadImportToCF } = useCFImageUpload();

  const panelSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const handlePanelModalClose = () => {
    onClose();
    setEnhanceSourceImage(null);
    setEnhanceUploading(false);
    setPanelMode('generate');
    resetEnhanceFiles();
    setAnnotationElements([]);
    setOriginalSourceUrl(null);
    setBulkItems([]);
    setBulkEnhance(true);
    resetBulkFiles();
    setImportSelected([]);
  };

  // Auto-switch to enhance tab when initialEnhanceSource is provided (e.g., from sketch edit)
  useEffect(() => {
    if (initialEnhanceSource) {
      setEnhanceSourceImage(initialEnhanceSource);
      setPanelMode('enhance');
    }
  }, [initialEnhanceSource]);

  // ── Enhance handlers ──
  const handleEnhanceImageDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    setEnhanceUploading(true);
    try {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
        img.onload = () => {
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
          URL.revokeObjectURL(objectUrl);
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error('Failed to load image'));
        };
        img.src = objectUrl;
      }).catch(() => ({ width: 512, height: 512 }));

      const result = await uploadEnhanceToCF(file);
      setEnhanceSourceImage({
        url: result.id,
        previewUrl: getEdgeUrl(result.id, { width: 400 }) ?? result.id,
        width: dims.width,
        height: dims.height,
      });
    } finally {
      setEnhanceUploading(false);
    }
  };

  const handleOpenImageSelector = () => {
    dialogStore.trigger({
      component: ImageSelectModal,
      props: {
        title: 'Select from Generator',
        selectSource: 'generation' as const,
        videoAllowed: false,
        importedUrls: [],
        onSelect: async (selected: { url: string; meta?: Record<string, unknown> }[]) => {
          if (selected.length === 0) return;
          const img = selected[0];
          const width = (img.meta?.width as number) ?? 512;
          const height = (img.meta?.height as number) ?? 512;

          setEnhanceUploading(true);
          try {
            const cfId = await fetchAndUploadGeneratorImage(
              img.url,
              'enhance',
              uploadEnhanceToCF
            );
            setEnhanceSourceImage({
              url: cfId,
              previewUrl: getEdgeUrl(cfId, { width: 400 }) ?? cfId,
              width,
              height,
            });
          } catch (err) {
            console.error('Failed to upload generator image:', err);
            setEnhanceSourceImage({
              url: img.url,
              previewUrl: img.url,
              width,
              height,
            });
          } finally {
            setEnhanceUploading(false);
          }
        },
      },
    });
  };

  // Open sketch/annotation editor on the current enhance source image
  const handleAnnotateSource = () => {
    if (!enhanceSourceImage) return;

    // Always draw on the original (clean) source so annotations layer correctly.
    // On first annotate, save the current url as the original.
    const cleanUrl = originalSourceUrl ?? enhanceSourceImage.url;
    if (!originalSourceUrl) setOriginalSourceUrl(enhanceSourceImage.url);

    const sourceUrl = cleanUrl.startsWith('http')
      ? cleanUrl
      : getEdgeUrl(cleanUrl, { original: true }) ?? cleanUrl;

    dialogStore.trigger({
      component: DrawingEditorModal,
      props: {
        sourceImage: {
          url: sourceUrl,
          width: enhanceSourceImage.width,
          height: enhanceSourceImage.height,
        },
        initialLines: annotationElements,
        confirmLabel: 'Continue to Enhance',
        onConfirm: async (blob: Blob, elements: DrawingElement[]) => {
          setAnnotationElements(elements);
          setEnhanceUploading(true);
          try {
            const file = new File([blob], 'annotated-source.jpg', { type: 'image/jpeg' });
            const result = await uploadEnhanceToCF(file);
            setEnhanceSourceImage({
              url: result.id,
              previewUrl: getEdgeUrl(result.id, { width: 400 }) ?? result.id,
              width: enhanceSourceImage.width,
              height: enhanceSourceImage.height,
            });
          } catch (err) {
            showErrorNotification({
              error: err as Error,
              title: 'Failed to save annotation',
            });
          } finally {
            setEnhanceUploading(false);
          }
        },
      },
    });
  };

  // ── Bulk handlers ──
  const handleBulkImageDrop = async (files: File[]) => {
    if (files.length === 0) return;
    setBulkUploading(true);
    try {
      const newItems: BulkPanelItem[] = [];
      for (const file of files) {
        const img = new window.Image();
        const objectUrl = URL.createObjectURL(file);
        const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
          img.onload = () => {
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
            URL.revokeObjectURL(objectUrl);
          };
          img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('Failed to load image'));
          };
          img.src = objectUrl;
        }).catch(() => ({ width: 512, height: 512 }));

        const result = await uploadBulkToCF(file);
        newItems.push({
          id: `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          sourceImage: {
            url: result.id,
            cfId: result.id,
            width: dims.width,
            height: dims.height,
            preview: getEdgeUrl(result.id, { width: 120 }) ?? result.id,
          },
          prompt: '',
          aspectRatio: '3:4',
        });
      }
      setBulkItems((prev) => [...prev, ...newItems].slice(0, 20));
    } finally {
      setBulkUploading(false);
    }
  };

  const handleBulkAddPrompt = () => {
    setBulkItems((prev) =>
      [
        ...prev,
        {
          id: `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          prompt: '',
          aspectRatio: '3:4',
        },
      ].slice(0, 20)
    );
  };

  const handleBulkFromGenerator = () => {
    dialogStore.trigger({
      component: ImageSelectModal,
      props: {
        title: 'Select from Generator',
        selectSource: 'generation' as const,
        videoAllowed: false,
        importedUrls: [],
        onSelect: async (selected: { url: string; meta?: Record<string, unknown> }[]) => {
          if (selected.length === 0) return;
          setBulkUploading(true);
          try {
            const newItems: BulkPanelItem[] = [];
            for (const img of selected) {
              const width = (img.meta?.width as number) ?? 512;
              const height = (img.meta?.height as number) ?? 512;
              let cfId: string;
              try {
                cfId = await fetchAndUploadGeneratorImage(img.url, 'bulk_gen', uploadBulkToCF);
              } catch (err) {
                console.error('Failed to upload generator image:', err);
                cfId = img.url;
              }
              newItems.push({
                id: `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                sourceImage: {
                  url: cfId,
                  cfId,
                  width,
                  height,
                  preview: getEdgeUrl(cfId, { width: 120 }) ?? cfId,
                },
                prompt: '',
                aspectRatio: '3:4',
              });
            }
            setBulkItems((prev) => [...prev, ...newItems].slice(0, 20));
          } finally {
            setBulkUploading(false);
          }
        },
      },
    });
  };

  const handleBulkDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setBulkItems((prev) => {
      const oldIndex = prev.findIndex((item) => item.id === active.id);
      const newIndex = prev.findIndex((item) => item.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return prev;
      return arrayMove(prev, oldIndex, newIndex);
    });
  };

  const handleBulkSubmit = async () => {
    if (bulkItems.length === 0 || isSubmitting) return;
    onBulkCreate(bulkItems, bulkEnhance);
  };

  const bulkGenerationCount = bulkItems.filter((item) => item.prompt.trim() !== '').length;
  const costReady = panelCost != null;
  const effectivePanelCost = panelCost ?? 0;
  const effectiveEnhanceCost = enhanceCost ?? 0;
  const bulkTotalCost = bulkGenerationCount * (effectivePanelCost + (bulkEnhance ? effectiveEnhanceCost : 0));

  // ── Import handlers ──
  const handleImportSelect = () => {
    dialogStore.trigger({
      component: ImageSelectModal,
      props: {
        title: 'Import Images as Panels',
        selectSource: 'generation' as const,
        videoAllowed: false,
        importedUrls: importSelected.map((s) => s.url),
        onSelect: async (selected: { url: string; meta?: Record<string, unknown> }[]) => {
          if (selected.length === 0) return;
          setImportUploading(true);
          try {
            const newItems: typeof importSelected = [];
            for (const img of selected) {
              const width = (img.meta?.width as number) ?? 512;
              const height = (img.meta?.height as number) ?? 512;
              try {
                const cfId = await fetchAndUploadGeneratorImage(
                  img.url,
                  'import',
                  uploadImportToCF
                );
                newItems.push({
                  url: cfId,
                  cfId,
                  width,
                  height,
                  preview: getEdgeUrl(cfId, { width: 120 }) ?? cfId,
                });
              } catch (err) {
                console.error('Failed to upload import image:', err);
              }
            }
            setImportSelected((prev) => [...prev, ...newItems]);
          } finally {
            setImportUploading(false);
          }
        },
      },
    });
  };

  const handleImportRemove = (idx: number) => {
    setImportSelected((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleImportSubmit = () => {
    if (importSelected.length === 0 || isSubmitting) return;
    onImportSubmit(importSelected);
  };

  const handleEnhanceSubmit = () => {
    if (!enhanceSourceImage) return;
    onEnhancePanel(enhanceSourceImage);
  };

  // Expose panelMode to parent for setting from outside (regenerate)
  // The parent can reset panelMode by closing and reopening the modal

  return (
    <Modal
      opened={opened}
      onClose={handlePanelModalClose}
      title={
        regeneratingPanelId
          ? panelMode === 'enhance'
            ? 'Enhance Panel'
            : 'Regenerate Panel'
          : insertAtPosition != null
          ? 'Insert Panel'
          : 'Create Panel'
      }
      size="lg"
    >
      {/* Tab bar */}
      {!regeneratingPanelId && (
        <div className={styles.panelModeTabs}>
          <button
            className={clsx(
              styles.panelModeTab,
              panelMode === 'generate' && styles.panelModeTabActive
            )}
            onClick={() => setPanelMode('generate')}
          >
            <IconSparkles
              size={14}
              style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }}
            />
            Generate
          </button>
          <button
            className={clsx(
              styles.panelModeTab,
              panelMode === 'enhance' && styles.panelModeTabActive
            )}
            onClick={() => setPanelMode('enhance')}
          >
            <IconWand
              size={14}
              style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }}
            />
            Enhance
          </button>
          <button
            className={clsx(
              styles.panelModeTab,
              panelMode === 'bulk' && styles.panelModeTabActive
            )}
            onClick={() => setPanelMode('bulk')}
          >
            <IconUpload
              size={14}
              style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }}
            />
            Bulk Add
          </button>
          <button
            className={clsx(
              styles.panelModeTab,
              panelMode === 'import' && styles.panelModeTabActive
            )}
            onClick={() => setPanelMode('import')}
          >
            <IconPhoto
              size={14}
              style={{ display: 'inline', verticalAlign: -2, marginRight: 4 }}
            />
            Import
          </button>
        </div>
      )}

      <Text size="xs" c="dimmed">
        Generated panels use the selected AI model and some are SFW only. Uploaded or imported images can
        be NSFW but will be scanned.
      </Text>

      {panelMode === 'generate' ? (
        <Stack gap="md">
          <MentionTextarea
            label="Describe the scene"
            value={prompt}
            onChange={setPrompt}
            references={mentionRefs}
            placeholder="Describe the scene... Use @Name to include references (e.g., @Maya on a rooftop)"
            rows={4}
          />

          <Switch
            label="Enhance prompt"
            description="Use AI to add detail and composition to your prompt"
            checked={enhancePrompt}
            onChange={(e) => setEnhancePrompt(e.currentTarget.checked)}
            color="yellow"
          />
          {activeChapterPanelCount > 0 && insertAtPosition !== 0 && (
            <>
              {enhancePrompt && (
                <Switch
                  label="Use previous panel context"
                  description="Pass the previous panel's prompt to the AI for visual continuity"
                  checked={useContext}
                  onChange={(e) => setUseContext(e.currentTarget.checked)}
                  ml="md"
                />
              )}
              <Switch
                label="Reference previous panel image"
                description="Include the previous panel's image as a reference for generation"
                checked={includePreviousImage}
                onChange={(e) => setIncludePreviousImage(e.currentTarget.checked)}
              />
            </>
          )}

          {needsImageSelection && (
            <ImageSelectionSection
              mentionedReferences={mentionedReferences}
              selectedImageIds={selectedImageIds}
              setSelectedImageIds={setSelectedImageIds}
              refImageBudget={refImageBudget}
            />
          )}

          <Select
            label="Generation Model"
            description="Each model has different strengths, image limits, and supported sizes"
            data={COMIC_MODEL_OPTIONS}
            value={effectiveModel}
            onChange={onModelChange}
            size="sm"
          />
          <AspectRatioSelector
            value={aspectRatio}
            onChange={setAspectRatio}
            aspectRatios={activeAspectRatios}
            description="Controls the panel dimensions. Portrait (3:4) works best for most comic panels."
          />

          <Group justify="flex-end">
            <Button variant="default" onClick={handlePanelModalClose}>
              Cancel
            </Button>
            <Tooltip
              label={costReady ? `Generation: ${effectivePanelCost} Buzz + Enhance: ${effectiveEnhanceCost} Buzz` : 'Loading cost...'}
              disabled={!enhancePrompt && costReady}
              withArrow
              position="top"
            >
              <BuzzTransactionButton
                buzzAmount={effectivePanelCost + (enhancePrompt ? effectiveEnhanceCost : 0)}
                label={!costReady ? 'Loading cost...' : insertAtPosition != null ? 'Insert' : 'Generate'}
                loading={isSubmitting || isCreatePending}
                disabled={!prompt.trim() || !costReady}
                onPerformTransaction={onGeneratePanel}
                showPurchaseModal
              />
            </Tooltip>
          </Group>
        </Stack>
      ) : panelMode === 'enhance' ? (
        <Stack gap="md">
          {/* Source image selection */}
          {!enhanceSourceImage ? (
            <div>
              <Text size="sm" fw={500} mb={8}>
                Source Image
              </Text>
              {enhanceUploading ? (
                <div
                  className="flex flex-col items-center justify-center gap-2"
                  style={{
                    background: '#2C2E33',
                    borderRadius: 8,
                    padding: 24,
                  }}
                >
                  <Loader size="sm" />
                  <Text size="xs" c="dimmed">
                    Uploading image...
                  </Text>
                </div>
              ) : (
                <div className={styles.enhanceSourceOptions}>
                  <Dropzone onDrop={handleEnhanceImageDrop} accept={IMAGE_MIME_TYPE} maxFiles={1}>
                    <Stack align="center" gap={4} py="sm" style={{ pointerEvents: 'none' }}>
                      <Dropzone.Accept>
                        <IconUpload size={24} className="text-blue-500" />
                      </Dropzone.Accept>
                      <Dropzone.Reject>
                        <IconX size={24} className="text-red-500" />
                      </Dropzone.Reject>
                      <Dropzone.Idle>
                        <IconPhotoUp size={24} style={{ color: '#909296' }} />
                      </Dropzone.Idle>
                      <Text size="xs" c="dimmed" ta="center">
                        Upload Image
                      </Text>
                    </Stack>
                  </Dropzone>
                  <button
                    className={styles.subtleBtn}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      padding: 16,
                      height: 'auto',
                    }}
                    onClick={handleOpenImageSelector}
                  >
                    <IconWand size={24} style={{ marginBottom: 4 }} />
                    <Text size="xs">From Generator</Text>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div>
              <Text size="sm" fw={500} mb={8}>
                Source Image
              </Text>
              <div className={styles.enhanceImagePreview}>
                <img
                  src={
                    enhanceSourceImage.previewUrl.startsWith('http')
                      ? enhanceSourceImage.previewUrl
                      : getEdgeUrl(enhanceSourceImage.previewUrl, { width: 400 }) ??
                        enhanceSourceImage.previewUrl
                  }
                  alt="Source"
                />
                <div
                  style={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    display: 'flex',
                    gap: 4,
                  }}
                >
                  <Tooltip label="Annotate image">
                    <ActionIcon
                      variant="filled"
                      color="dark"
                      size="sm"
                      onClick={handleAnnotateSource}
                    >
                      <IconPencil size={14} />
                    </ActionIcon>
                  </Tooltip>
                  <ActionIcon
                    variant="filled"
                    color="dark"
                    size="sm"
                    onClick={() => {
                      setEnhanceSourceImage(null);
                      resetEnhanceFiles();
                      setAnnotationElements([]);
                      setOriginalSourceUrl(null);
                    }}
                  >
                    <IconX size={14} />
                  </ActionIcon>
                </div>
              </div>
            </div>
          )}

          {/* Optional enhancement prompt */}
          <MentionTextarea
            label="Enhancement prompt (optional)"
            value={prompt}
            onChange={setPrompt}
            references={mentionRefs}
            placeholder="Optionally describe changes... Use @Name to include references"
            rows={3}
          />

          {prompt.trim() && (
            <>
              <Switch
                label="Enhance prompt"
                description="Use AI to add detail and composition to your prompt"
                checked={enhancePrompt}
                onChange={(e) => setEnhancePrompt(e.currentTarget.checked)}
                color="yellow"
              />
              {activeChapterPanelCount > 0 &&
                insertAtPosition !== 0 &&
                enhancePrompt && (
                  <Switch
                    label="Use previous panel context"
                    description="Pass the previous panel's prompt to the AI for visual continuity"
                    checked={useContext}
                    onChange={(e) => setUseContext(e.currentTarget.checked)}
                    ml="md"
                  />
                )}
              {activeChapterPanelCount > 0 && insertAtPosition !== 0 && (
                <Switch
                  label="Reference previous panel image"
                  description="Include the previous panel's image as a reference for generation"
                  checked={includePreviousImage}
                  onChange={(e) => setIncludePreviousImage(e.currentTarget.checked)}
                />
              )}
              {needsImageSelection && (
                <ImageSelectionSection
                  mentionedReferences={mentionedReferences}
                  selectedImageIds={selectedImageIds}
                  setSelectedImageIds={setSelectedImageIds}
                  refImageBudget={refImageBudget}
                />
              )}
            </>
          )}

          <Select
            label="Generation Model"
            description="Each model has different strengths, image limits, and supported sizes"
            data={COMIC_MODEL_OPTIONS}
            value={effectiveModel}
            onChange={onModelChange}
            size="sm"
          />
          {(annotationElements.length > 0 || initialEnhanceSource) && (
            <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />} py="xs">
              <Text size="xs">
                Tip: Sketch annotations work best with Nano Banana. Results may vary with other
                models.
              </Text>
            </Alert>
          )}
          <AspectRatioSelector
            value={aspectRatio}
            onChange={setAspectRatio}
            aspectRatios={activeAspectRatios}
            description="Controls the panel dimensions. Portrait (3:4) works best for most comic panels."
          />

          <Group justify="flex-end">
            <Button variant="default" onClick={handlePanelModalClose}>
              Cancel
            </Button>
            <BuzzTransactionButton
              buzzAmount={(enhanceGenCost ?? 0) + (prompt.trim() && enhancePrompt ? effectiveEnhanceCost : 0)}
              label={enhanceGenCost == null ? 'Loading cost...' : regeneratingPanelId ? 'Regenerate' : 'Enhance'}
              loading={isSubmitting || isEnhancePending}
              disabled={!enhanceSourceImage || enhanceGenCost == null}
              onPerformTransaction={handleEnhanceSubmit}
              showPurchaseModal
            />
          </Group>
        </Stack>
      ) : panelMode === 'bulk' ? (
        /* ── Bulk Add tab ─── */
        <Stack gap="md">
          <Dropzone
            onDrop={handleBulkImageDrop}
            accept={IMAGE_MIME_TYPE}
            maxFiles={20}
            disabled={bulkUploading || bulkItems.length >= 20}
          >
            <Stack align="center" gap={4} py="sm" style={{ pointerEvents: 'none' }}>
              <Dropzone.Accept>
                <IconUpload size={24} className="text-blue-500" />
              </Dropzone.Accept>
              <Dropzone.Reject>
                <IconX size={24} className="text-red-500" />
              </Dropzone.Reject>
              <Dropzone.Idle>
                <IconPhotoUp size={24} style={{ color: '#909296' }} />
              </Dropzone.Idle>
              <Text size="sm" fw={500}>
                {bulkUploading ? 'Uploading...' : 'Drop images here or click to upload'}
              </Text>
              <Text size="xs" c="dimmed">
                Up to {20 - bulkItems.length} images. Add prompts for generation/enhancement.
              </Text>
            </Stack>
          </Dropzone>

          <Group gap="xs">
            <Button
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={handleBulkAddPrompt}
              disabled={bulkItems.length >= 20}
              size="xs"
            >
              Add text-to-image prompt
            </Button>
            <Button
              variant="light"
              leftSection={<IconWand size={14} />}
              onClick={handleBulkFromGenerator}
              disabled={bulkItems.length >= 20 || bulkUploading}
              size="xs"
            >
              From Generator
            </Button>
          </Group>

          <Select
            label="Generation Model"
            description="Each model has different strengths, image limits, and supported sizes"
            data={COMIC_MODEL_OPTIONS}
            value={effectiveModel}
            onChange={onModelChange}
            size="sm"
          />
          <Switch
            label="Enhance prompts"
            description="Use AI to add detail and composition to prompts"
            checked={bulkEnhance}
            onChange={(e) => setBulkEnhance(e.currentTarget.checked)}
            color="yellow"
          />

          {bulkItems.length > 0 && (
            <DndContext
              sensors={panelSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleBulkDragEnd}
            >
              <SortableContext items={bulkItems.map((item) => item.id)}>
                <ScrollArea.Autosize mah={320}>
                  <Stack gap="xs">
                    {bulkItems.map((item, idx) => (
                      <SortableBulkItem
                        key={item.id}
                        item={item}
                        index={idx}
                        onUpdatePrompt={(id, p) =>
                          setBulkItems((prev) =>
                            prev.map((i) => (i.id === id ? { ...i, prompt: p } : i))
                          )
                        }
                        onUpdateAspectRatio={(id, ar) =>
                          setBulkItems((prev) =>
                            prev.map((i) => (i.id === id ? { ...i, aspectRatio: ar } : i))
                          )
                        }
                        onRemove={(id) => setBulkItems((prev) => prev.filter((i) => i.id !== id))}
                        aspectRatioLabels={activeAspectRatios.map((r) => r.label)}
                      />
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              </SortableContext>
            </DndContext>
          )}

          {bulkItems.length > 0 && (
            <Text size="xs" c="dimmed">
              {bulkItems.length} item{bulkItems.length !== 1 ? 's' : ''} queued
              {bulkGenerationCount > 0 && (
                <span>
                  {' '}
                  &middot; {bulkGenerationCount} generation{bulkGenerationCount !== 1 ? 's' : ''}{' '}
                  = {costReady ? `${bulkTotalCost} Buzz` : 'Calculating...'}
                </span>
              )}
              {bulkItems.length - bulkGenerationCount > 0 && (
                <span>
                  {' '}
                  &middot; {bulkItems.length - bulkGenerationCount} free upload
                  {bulkItems.length - bulkGenerationCount !== 1 ? 's' : ''}
                </span>
              )}
            </Text>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={handlePanelModalClose}>
              Cancel
            </Button>
            {bulkTotalCost > 0 || (bulkGenerationCount > 0 && !costReady) ? (
              <BuzzTransactionButton
                buzzAmount={bulkTotalCost}
                label={!costReady ? 'Loading cost...' : `Add ${bulkItems.length} Panel${bulkItems.length !== 1 ? 's' : ''}`}
                loading={isSubmitting || isBulkPending}
                disabled={
                  bulkItems.length === 0 ||
                  !costReady ||
                  bulkItems.some((item) => !item.sourceImage && !item.prompt.trim())
                }
                onPerformTransaction={handleBulkSubmit}
                showPurchaseModal
              />
            ) : (
              <Button
                onClick={handleBulkSubmit}
                loading={isSubmitting || isBulkPending}
                disabled={
                  bulkItems.length === 0 ||
                  bulkItems.some((item) => !item.sourceImage && !item.prompt.trim())
                }
              >
                Add {bulkItems.length} Panel{bulkItems.length !== 1 ? 's' : ''}
              </Button>
            )}
          </Group>
        </Stack>
      ) : (
        /* ── Import tab ─── */
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Select images from your generator history to import as panels.
          </Text>

          <Button
            variant="light"
            leftSection={<IconPhotoUp size={14} />}
            onClick={handleImportSelect}
            loading={importUploading}
          >
            {importUploading ? 'Uploading...' : 'Select Images'}
          </Button>

          {importSelected.length > 0 && (
            <ScrollArea.Autosize mah={320}>
              <div className="flex flex-wrap gap-2">
                {importSelected.map((img, idx) => (
                  <div key={idx} className="relative group">
                    <img
                      src={img.preview}
                      alt={`Import ${idx + 1}`}
                      className="w-20 h-20 object-cover rounded"
                    />
                    <ActionIcon
                      variant="filled"
                      color="dark"
                      size="xs"
                      className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => handleImportRemove(idx)}
                    >
                      <IconX size={12} />
                    </ActionIcon>
                  </div>
                ))}
              </div>
            </ScrollArea.Autosize>
          )}

          {importSelected.length > 0 && (
            <Text size="xs" c="dimmed">
              {importSelected.length} image{importSelected.length !== 1 ? 's' : ''} ready to import
            </Text>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={handlePanelModalClose}>
              Cancel
            </Button>
            <Button
              onClick={handleImportSubmit}
              loading={isSubmitting || isBulkPending}
              disabled={importSelected.length === 0}
            >
              Import {importSelected.length} Panel{importSelected.length !== 1 ? 's' : ''}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
