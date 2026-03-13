import {
  ActionIcon,
  Badge,
  Button,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArrowLeft,
  IconBook,
  IconCalendar,
  IconEye,
  IconEyeOff,
  IconGripVertical,
  IconLock,
  IconPhoto,
  IconPlus,
  IconSettings,
  IconSparkles,
  IconUser,
  IconWorld,
} from '@tabler/icons-react';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { slugit } from '~/utils/string-helpers';

import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext } from '@dnd-kit/sortable';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { dialogStore } from '~/components/Dialog/dialogStore';

const DrawingEditorModal = dynamic(
  () =>
    import(
      '~/components/Generation/Input/DrawingEditor/DrawingEditorModal'
    ).then((mod) => mod.DrawingEditorModal),
  { ssr: false }
);
import { ChapterSettingsModal } from '~/components/Comics/ChapterSettingsModal';
import {
  COMIC_MODEL_MAX_IMAGES,
  COMIC_MODEL_SIZES,
  type BulkPanelItem,
} from '~/components/Comics/comic-project-constants';
import { PanelCard, SortablePanel, getNsfwLabel } from '~/components/Comics/PanelCard';
import { PanelDetailDrawer } from '~/components/Comics/PanelDetailDrawer';
import { PanelModal } from '~/components/Comics/PanelModal';
import { ProjectSettingsModal } from '~/components/Comics/ProjectSettingsModal';
import { PublishModal } from '~/components/Comics/PublishModal';
import { ReferenceSidebarItem } from '~/components/Comics/ReferenceSidebarItem';
import { SmartCreateModal } from '~/components/Comics/SmartCreateModal';
import { SortableChapter } from '~/components/Comics/SortableChapter';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { ComicChapterStatus, ComicPanelStatus } from '~/shared/utils/prisma/enums';
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

function ProjectWorkspace() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { id } = router.query;
  const projectId = Number(id);

  // ── Modal open/close ──
  const [panelModalOpened, { open: openPanelModal, close: closePanelModal }] = useDisclosure(false);
  const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
  const [publishModalOpened, { open: openPublishModal, close: closePublishModal }] =
    useDisclosure(false);
  const [chapterSettingsOpened, { open: openChapterSettings, close: closeChapterSettings }] =
    useDisclosure(false);
  const [smartModalOpened, { open: openSmartModal, close: closeSmartModal }] = useDisclosure(false);

  // ── Core shared state ──
  const [prompt, setPrompt] = useState('');
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [useContext, setUseContext] = useState(true);
  const [includePreviousImage, setIncludePreviousImage] = useState(false);
  const [aspectRatio, setAspectRatio] = useState('3:4');
  const [generationModel, setGenerationModel] = useState<
    'NanoBanana' | 'Flux2' | 'Seedream' | 'OpenAI' | 'Qwen' | 'Grok' | null
  >(null);
  const [activeChapterPosition, setActiveChapterPosition] = useState<number | null>(null);
  const [regeneratingPanelId, setRegeneratingPanelId] = useState<number | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [insertAtPosition, setInsertAtPosition] = useState<number | null>(null);
  const [detailPanelId, setDetailPanelId] = useState<number | null>(null);
  const [selectedImageIds, setSelectedImageIds] = useState<number[] | null>(null);
  const [publishEaInitial, setPublishEaInitial] = useState(false);
  const [enhanceExistingSource, setEnhanceExistingSource] = useState<{
    url: string;
    previewUrl: string;
    width: number;
    height: number;
  } | null>(null);
  const [chapterSettingsTarget, setChapterSettingsTarget] = useState<{
    position: number;
    name: string;
    status: string;
    earlyAccessConfig: { buzzPrice: number; timeframe: number } | null;
  } | null>(null);

  const panelSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const chapterSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  // ── tRPC queries ──
  const {
    data: project,
    isLoading,
    refetch,
  } = trpc.comics.getProject.useQuery({ id: projectId }, { enabled: projectId > 0 });

  const effectiveModel = generationModel ?? project?.baseModel ?? 'NanoBanana';
  const activeAspectRatios = COMIC_MODEL_SIZES[effectiveModel] ?? COMIC_MODEL_SIZES.NanoBanana;

  const { data: costEstimate } = trpc.comics.getPanelCostEstimate.useQuery(
    { baseModel: effectiveModel },
    { staleTime: 5 * 60 * 1000 }
  );
  const panelCost = costEstimate?.cost ?? 25;

  const { data: enhanceCostEstimate } = trpc.comics.getPromptEnhanceCostEstimate.useQuery(
    undefined,
    { staleTime: 5 * 60 * 1000 }
  );
  const enhanceCost = enhanceCostEstimate?.cost ?? 0;

  const { data: planCostEstimate } = trpc.comics.getPlanChapterCostEstimate.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const planCost = planCostEstimate?.cost ?? 0;

  // ── Active chapter ──
  useEffect(() => {
    if (project?.chapters?.length && activeChapterPosition == null) {
      setActiveChapterPosition(project.chapters[0].position);
    }
  }, [project?.chapters, activeChapterPosition]);

  const activeChapter = useMemo(
    () =>
      project?.chapters?.find((ch) => ch.position === activeChapterPosition) ??
      project?.chapters?.[0],
    [project?.chapters, activeChapterPosition]
  );

  // ── References ──
  const allReferences = useMemo(() => project?.references ?? [], [project?.references]);

  const referenceImageMap = useMemo(() => {
    const map = new Map<number, { url: string }>();
    for (const c of allReferences) {
      const firstImage = (c as any).images?.[0]?.image;
      if (firstImage?.url) {
        map.set(c.id, { url: firstImage.url });
      }
    }
    return map;
  }, [allReferences]);

  const referenceNameMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const c of allReferences) {
      map.set(c.id, c.name);
    }
    return map;
  }, [allReferences]);

  const activeReferences = useMemo(
    () => allReferences.filter((c) => c.status === 'Ready'),
    [allReferences]
  );

  const maxReferenceImages = COMIC_MODEL_MAX_IMAGES[effectiveModel] ?? 7;

  const mentionedReferences = useMemo(() => {
    if (!prompt.trim()) return [];
    const sorted = [...activeReferences].sort((a, b) => b.name.length - a.name.length);
    const mentioned = new Set<number>();
    for (const ref of sorted) {
      const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`@${escaped}(?=$|[\\s.,!?;:'")])`, 'gi');
      if (pattern.test(prompt)) {
        mentioned.add(ref.id);
      }
    }
    return activeReferences.filter((r) => mentioned.has(r.id));
  }, [prompt, activeReferences]);

  const mentionedRefImageCount = useMemo(
    () => mentionedReferences.reduce((sum, c) => sum + ((c as any).images?.length ?? 0), 0),
    [mentionedReferences]
  );

  const mentionedIdKey = mentionedReferences.map((r) => r.id).join(',');
  useEffect(() => {
    setSelectedImageIds(null);
  }, [mentionedIdKey]);

  const reservedSlots = useMemo(() => (includePreviousImage ? 1 : 0), [includePreviousImage]);
  const refImageBudget = maxReferenceImages - reservedSlots;

  const needsImageSelection =
    mentionedReferences.length > 0 && mentionedRefImageCount > refImageBudget;

  const mentionRefs = useMemo(
    () => activeReferences.map((c) => ({ id: c.id, name: c.name })),
    [activeReferences]
  );

  // ── Polling ──
  const generatingPanelIds = useMemo(
    () => (activeChapter?.panels ?? []).filter((p) => p.status === 'Generating').map((p) => p.id),
    [activeChapter?.panels]
  );

  const handledPanelIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const current = new Set(generatingPanelIds);
    for (const panelId of handledPanelIdsRef.current) {
      if (!current.has(panelId)) handledPanelIdsRef.current.delete(panelId);
    }
  }, [generatingPanelIds]);

  const utils = trpc.useUtils();

  useEffect(() => {
    if (generatingPanelIds.length === 0) return;
    const interval = setInterval(async () => {
      const toPoll = generatingPanelIds.filter((pid) => !handledPanelIdsRef.current.has(pid));
      if (toPoll.length === 0) return;
      try {
        const results = await Promise.all(
          toPoll.map((panelId) => utils.comics.pollPanelStatus.fetch({ panelId }))
        );
        let hasTerminal = false;
        const failedCount = results.filter((r) => r.status === 'Failed').length;
        for (let i = 0; i < results.length; i++) {
          const status = results[i].status;
          if (status === 'Ready' || status === 'Failed') {
            handledPanelIdsRef.current.add(toPoll[i]);
            hasTerminal = true;
          }
        }
        if (failedCount > 0) {
          showErrorNotification({
            title: 'Panel generation failed',
            error: new Error('Buzz has been refunded automatically.'),
          });
        }
        if (hasTerminal) refetch();
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatingPanelIds.join(','), utils, refetch]);

  const processingReferenceIds = useMemo(
    () => allReferences.filter((c) => c.status === 'Pending').map((c) => c.id),
    [allReferences]
  );

  useEffect(() => {
    if (processingReferenceIds.length === 0) return;
    const interval = setInterval(async () => {
      try {
        const results = await Promise.all(
          processingReferenceIds.map((cid) =>
            utils.comics.pollReferenceStatus.fetch({ referenceId: cid })
          )
        );
        if (results.some((r) => r.status === 'Ready' || r.status === 'Failed')) refetch();
      } catch {
        /* ignore */
      }
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processingReferenceIds.join(','), utils, refetch]);

  // ── Mutations ──
  const handleMutationError = (error: any) => {
    showErrorNotification({ error, title: 'Something went wrong' });
  };

  const createPanelMutation = trpc.comics.createPanel.useMutation({
    onSuccess: () => {
      closePanelModal();
      setPrompt('');
      setRegeneratingPanelId(null);
      setInsertAtPosition(null);
      refetch();
    },
    onError: handleMutationError,
  });

  const enhancePanelMutation = trpc.comics.enhancePanel.useMutation({
    onSuccess: () => {
      closePanelModal();
      setPrompt('');
      setInsertAtPosition(null);
      refetch();
    },
    onError: handleMutationError,
  });

  const updatePanelMutation = trpc.comics.updatePanel.useMutation({
    onSuccess: () => refetch(),
    onError: handleMutationError,
  });

  const replacePanelImageMutation = trpc.comics.replacePanelImage.useMutation({
    onSuccess: () => refetch(),
    onError: handleMutationError,
  });

  const deletePanelMutation = trpc.comics.deletePanel.useMutation({
    onSuccess: () => {
      refetch();
      setDetailPanelId(null);
    },
    onError: handleMutationError,
  });

  const reorderPanelsMutation = trpc.comics.reorderPanels.useMutation({
    onError: (err) => {
      handleMutationError(err);
      refetch();
    },
  });

  const createChapterMutation = trpc.comics.createChapter.useMutation({
    onSuccess: (data) => {
      setActiveChapterPosition(data.position);
      refetch();
    },
    onError: handleMutationError,
  });

  const updateChapterMutation = trpc.comics.updateChapter.useMutation({
    onSuccess: () => refetch(),
    onError: handleMutationError,
  });

  const updateChapterEaMutation = trpc.comics.updateChapterEarlyAccess.useMutation({
    onSuccess: () => refetch(),
    onError: handleMutationError,
  });

  const deleteChapterMutation = trpc.comics.deleteChapter.useMutation({
    onSuccess: () => refetch(),
    onError: handleMutationError,
  });

  const updateProjectMutation = trpc.comics.updateProject.useMutation({
    onSuccess: () => {
      closeSettings();
      refetch();
    },
    onError: handleMutationError,
  });

  const deleteReferenceMutation = trpc.comics.deleteReference.useMutation({
    onSuccess: () => refetch(),
    onError: handleMutationError,
  });

  const deleteProjectMutation = trpc.comics.deleteProject.useMutation({
    onSuccess: () => {
      const username = currentUser?.username;
      router.push(username ? `/user/${username}/comics` : '/comics');
    },
    onError: handleMutationError,
  });

  const publishChapterMutation = trpc.comics.publishChapter.useMutation({
    onSuccess: () => refetch(),
    onError: handleMutationError,
  });

  const unpublishChapterMutation = trpc.comics.unpublishChapter.useMutation({
    onSuccess: () => refetch(),
    onError: handleMutationError,
  });

  const planPanelsMutation = trpc.comics.planChapterPanels.useMutation({
    onError: handleMutationError,
  });

  const smartCreateMutation = trpc.comics.smartCreateChapter.useMutation({
    onSuccess: (data) => {
      closeSmartModal();
      setActiveChapterPosition(data.position);
      refetch();
    },
    onError: handleMutationError,
  });

  const bulkCreateMutation = trpc.comics.bulkCreatePanels.useMutation({
    onSuccess: () => {
      closePanelModal();
      setInsertAtPosition(null);
      refetch();
    },
    onError: handleMutationError,
  });

  const reorderChaptersMutation = trpc.comics.reorderChapters.useMutation({
    onError: (err) => {
      handleMutationError(err);
      refetch();
    },
  });

  const { uploadToCF: uploadSketchToCF } = useCFImageUpload();

  // ── Handlers ──
  const handleModelChange = (value: string | null) => {
    setGenerationModel(value as typeof generationModel);
    const newSizes =
      COMIC_MODEL_SIZES[value ?? project?.baseModel ?? 'NanoBanana'] ??
      COMIC_MODEL_SIZES.NanoBanana;
    const defaultLabel =
      newSizes.find((s) => s.label === '3:4' || s.label === 'Portrait' || s.label === '2:3')
        ?.label ?? newSizes[0].label;
    if (!newSizes.some((s) => s.label === aspectRatio)) {
      setAspectRatio(defaultLabel);
    }
  };

  const handlePanelModalClose = () => {
    closePanelModal();
    setRegeneratingPanelId(null);
    setInsertAtPosition(null);
    setPrompt('');
    setUseContext(true);
    setIncludePreviousImage(false);
    setAspectRatio('3:4');
    setGenerationModel(null);
    setSelectedImageIds(null);
    setEnhanceExistingSource(null);
  };

  const handleGeneratePanel = async () => {
    if (!prompt.trim() || !activeChapter || isSubmitting) return;
    setIsSubmitting(true);
    try {
      let targetPosition = insertAtPosition;
      if (regeneratingPanelId && targetPosition == null) {
        const oldPanel = activeChapter.panels.find((p) => p.id === regeneratingPanelId);
        if (oldPanel) targetPosition = oldPanel.position;
      }
      if (regeneratingPanelId) {
        // Clear the existing panel image so the UI shows a spinner immediately
        await updatePanelMutation.mutateAsync({
          panelId: regeneratingPanelId,
          status: ComicPanelStatus.Generating,
          imageUrl: null,
        });
        await deletePanelMutation.mutateAsync({ panelId: regeneratingPanelId });
      }
      createPanelMutation.mutate({
        projectId,
        chapterPosition: activeChapter.position,
        prompt: prompt.trim(),
        enhance: enhancePrompt,
        useContext,
        includePreviousImage,
        aspectRatio,
        baseModel: generationModel,
        ...(targetPosition != null ? { position: targetPosition } : {}),
        ...(selectedImageIds ? { selectedImageIds } : {}),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnhancePanel = async (sourceImage: {
    url: string;
    previewUrl: string;
    width: number;
    height: number;
  }) => {
    if (!activeChapter || isSubmitting) return;
    setIsSubmitting(true);
    try {
      let targetPosition = insertAtPosition;
      if (regeneratingPanelId && targetPosition == null) {
        const oldPanel = activeChapter.panels.find((p) => p.id === regeneratingPanelId);
        if (oldPanel) targetPosition = oldPanel.position;
      }
      if (regeneratingPanelId) {
        // Clear the existing panel image so the UI shows a spinner immediately
        await updatePanelMutation.mutateAsync({
          panelId: regeneratingPanelId,
          status: ComicPanelStatus.Generating,
          imageUrl: null,
        });
        await deletePanelMutation.mutateAsync({ panelId: regeneratingPanelId });
      }
      enhancePanelMutation.mutate({
        projectId,
        chapterPosition: activeChapter.position,
        sourceImageUrl: sourceImage.url,
        sourceImageWidth: sourceImage.width,
        sourceImageHeight: sourceImage.height,
        prompt: prompt.trim() || undefined,
        enhance: enhancePrompt,
        useContext,
        includePreviousImage,
        aspectRatio,
        baseModel: generationModel,
        forceGenerate: true,
        ...(targetPosition != null ? { position: targetPosition } : {}),
        ...(selectedImageIds ? { selectedImageIds } : {}),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleBulkCreate = (items: BulkPanelItem[], enhance: boolean) => {
    if (!activeChapter || items.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    bulkCreateMutation.mutate(
      {
        projectId,
        chapterPosition: activeChapter.position,
        baseModel: generationModel,
        panels: items.map((item) => ({
          prompt: item.prompt?.trim() || undefined,
          enhance,
          sourceImageUrl: item.sourceImage?.url,
          sourceImageWidth: item.sourceImage?.width,
          sourceImageHeight: item.sourceImage?.height,
          aspectRatio: item.aspectRatio,
        })),
      },
      { onSettled: () => setIsSubmitting(false) }
    );
  };

  const handleImportSubmit = (
    items: { url: string; cfId: string; width: number; height: number; preview: string }[]
  ) => {
    if (!activeChapter || items.length === 0 || isSubmitting) return;
    setIsSubmitting(true);
    bulkCreateMutation.mutate(
      {
        projectId,
        chapterPosition: activeChapter.position,
        baseModel: generationModel,
        panels: items.map((img) => ({
          sourceImageUrl: img.url,
          sourceImageWidth: img.width,
          sourceImageHeight: img.height,
          aspectRatio: '3:4',
        })),
      },
      { onSettled: () => setIsSubmitting(false) }
    );
  };

  const handlePanelDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !activeChapter) return;
    const panels = activeChapter.panels;
    const oldIndex = panels.findIndex((p) => p.id === active.id);
    const newIndex = panels.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(panels, oldIndex, newIndex);

    // Optimistic update
    utils.comics.getProject.setData({ id: projectId }, (prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        chapters: prev.chapters.map((ch) =>
          ch.position === activeChapter.position
            ? { ...ch, panels: reordered.map((p, i) => ({ ...p, position: i })) }
            : ch
        ),
      };
    });

    reorderPanelsMutation.mutate({
      projectId,
      chapterPosition: activeChapter.position,
      panelIds: reordered.map((p) => p.id),
    });
  };

  const handleChapterDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !project) return;
    const chapters = project.chapters;
    const oldIndex = chapters.findIndex((ch) => ch.position === active.id);
    const newIndex = chapters.findIndex((ch) => ch.position === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reorderedChapters = arrayMove(chapters, oldIndex, newIndex);
    const newOrder = reorderedChapters.map((ch) => ch.position);

    // Optimistic update
    utils.comics.getProject.setData({ id: projectId }, (prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        chapters: reorderedChapters.map((ch, i) => ({ ...ch, position: i })),
      };
    });

    reorderChaptersMutation.mutate({ projectId, order: newOrder });
  };

  const handleOpenChapterSettings = (chapter: NonNullable<typeof project>['chapters'][number]) => {
    const eaConfig = chapter.earlyAccessConfig as {
      buzzPrice: number;
      timeframe: number;
    } | null;
    setChapterSettingsTarget({
      position: chapter.position,
      name: chapter.name,
      status: chapter.status,
      earlyAccessConfig: eaConfig,
    });
    openChapterSettings();
  };

  const handleSaveChapterSettings = (data: {
    position: number;
    name: string;
    eaConfig: { buzzPrice: number; timeframe: number } | null;
  }) => {
    if (!project) return;
    const chapter = project.chapters.find((ch) => ch.position === data.position);
    if (!chapter) return;

    if (data.name !== chapter.name) {
      updateChapterMutation.mutate({
        projectId,
        chapterPosition: data.position,
        name: data.name,
      });
    }

    if (chapter.status === ComicChapterStatus.Published) {
      const currentEaConfig = chapter.earlyAccessConfig as {
        buzzPrice: number;
        timeframe: number;
      } | null;
      if (JSON.stringify(data.eaConfig) !== JSON.stringify(currentEaConfig)) {
        updateChapterEaMutation.mutate({
          projectId,
          chapterPosition: data.position,
          earlyAccessConfig: data.eaConfig,
        });
      }
    }

    closeChapterSettings();
  };

  const handleDeleteChapter = (chapterPosition: number, chapterName: string) => {
    if (!project || project.chapters.length <= 1) return;
    openConfirmModal({
      title: 'Delete Chapter',
      children: (
        <Text size="sm">
          Are you sure you want to delete &quot;{chapterName}&quot;? All panels in this chapter will
          be permanently deleted.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteChapterMutation.mutate({ projectId, chapterPosition });
        if (activeChapterPosition === chapterPosition) {
          const remaining = project.chapters.filter((ch) => ch.position !== chapterPosition);
          setActiveChapterPosition(remaining[0]?.position ?? null);
        }
      },
    });
  };

  const handleTogglePublish = (chapterPosition: number, currentStatus: string) => {
    if (currentStatus === ComicChapterStatus.Published || currentStatus === ComicChapterStatus.Scheduled) {
      openConfirmModal({
        title: currentStatus === ComicChapterStatus.Scheduled ? 'Cancel Schedule' : 'Unpublish Chapter',
        children: (
          <Text size="sm">
            {currentStatus === ComicChapterStatus.Scheduled
              ? 'This will cancel the scheduled publish and revert the chapter to draft.'
              : 'This chapter will be reverted to draft and will no longer be visible to readers.'}
          </Text>
        ),
        labels: {
          confirm: currentStatus === ComicChapterStatus.Scheduled ? 'Cancel Schedule' : 'Unpublish',
          cancel: 'Keep',
        },
        confirmProps: { color: 'yellow' },
        onConfirm: () => {
          unpublishChapterMutation.mutate({ projectId, chapterPosition });
        },
      });
    } else {
      setActiveChapterPosition(chapterPosition);
      setPublishEaInitial(false);
      openPublishModal();
    }
  };

  const handleConfirmPublish = (
    eaConfig: { buzzPrice: number; timeframe: number } | null,
    scheduledAt?: Date
  ) => {
    if (activeChapterPosition == null) return;
    publishChapterMutation.mutate(
      {
        projectId,
        chapterPosition: activeChapterPosition,
        earlyAccessConfig: eaConfig,
        scheduledAt,
      },
      { onSuccess: () => closePublishModal() }
    );
  };

  const handleDeleteReference = (referenceId: number, referenceName: string) => {
    openConfirmModal({
      title: 'Delete Reference',
      children: (
        <Text size="sm">
          Are you sure you want to delete &quot;{referenceName}&quot;? Existing panels will be
          preserved but unlinked.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteReferenceMutation.mutate({ referenceId });
      },
    });
  };

  const handleRegenerate = (panel: {
    id: number;
    prompt: string;
    metadata: Record<string, any> | null;
  }) => {
    const meta = panel.metadata;
    setRegeneratingPanelId(panel.id);
    setPrompt(panel.prompt);
    setEnhancePrompt(meta?.enhanceEnabled ?? true);
    setUseContext(meta?.useContext ?? true);
    setIncludePreviousImage(meta?.includePreviousImage ?? false);
    setSelectedImageIds(meta?.selectedImageIds ?? null);
    openPanelModal();
  };

  const handleDrawerRegenerate = (panel: any) => {
    setDetailPanelId(null);
    handleRegenerate(panel);
  };

  const handleDrawerInsertAfter = (index: number) => {
    setDetailPanelId(null);
    setInsertAtPosition(index + 1);
    openPanelModal();
  };

  const handleSketchEdit = (panel: { id: number; imageUrl: string | null; image?: { width: number; height: number } | null }) => {
    if (!panel.imageUrl) return;
    const edgeUrl = getEdgeUrl(panel.imageUrl, { original: true }) ?? panel.imageUrl;

    const openSketchDialog = (imgWidth: number, imgHeight: number) => {
      dialogStore.trigger({
        component: DrawingEditorModal,
        props: {
          sourceImage: { url: edgeUrl, width: imgWidth, height: imgHeight } as any,
          onConfirm: async (blob: Blob) => {
            try {
              const file = new File([blob], 'sketch-annotation.jpg', { type: 'image/jpeg' });
              const result = await uploadSketchToCF(file);
              // Save with proper Image record creation and NSFW scanning
              await replacePanelImageMutation.mutateAsync({
                panelId: panel.id,
                imageUrl: result.id,
              });
            } catch (err) {
              console.error('Failed to save sketch edit:', err);
              showErrorNotification({ error: err as Error, title: 'Failed to save sketch edit' });
            }
          },
        },
      });
    };

    // Pre-load image to get actual dimensions (panel.image may be null)
    const img = new window.Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      openSketchDialog(img.naturalWidth || panel.image?.width || 1024, img.naturalHeight || panel.image?.height || 1024);
    };
    img.onerror = () => {
      openSketchDialog(panel.image?.width ?? 1024, panel.image?.height ?? 1024);
    };
    img.src = edgeUrl;
  };

  const handleEnhanceExisting = (panel: {
    id: number;
    imageUrl: string | null;
    image?: { width: number; height: number } | null;
  }) => {
    if (!panel.imageUrl) return;
    const previewUrl = getEdgeUrl(panel.imageUrl, { width: 400 }) ?? panel.imageUrl;
    setRegeneratingPanelId(panel.id);
    setEnhanceExistingSource({
      url: panel.imageUrl,
      previewUrl,
      width: panel.image?.width ?? 1024,
      height: panel.image?.height ?? 1024,
    });
    openPanelModal();
  };

  const handleDrawerEnhance = (panel: any) => {
    setDetailPanelId(null);
    handleEnhanceExisting(panel);
  };

  const getStatusDotClass = (status: string, hasRefs: boolean) => {
    if (status === 'Failed') return styles.failed;
    if (status === 'Ready' && !hasRefs) return styles.noRefs;
    if (status === 'Ready') return styles.ready;
    return styles.pending;
  };

  const getStatusLabel = (status: string, hasRefs: boolean, isFailed: boolean) => {
    if (isFailed) return 'Failed';
    if (status === 'Ready' && !hasRefs) return 'No refs';
    return status;
  };

  // ── Loading state ──
  if (isLoading || !project) {
    return (
      <Container size="xl" py="xl">
        <Stack align="center" gap="md" py={60}>
          <Loader color="yellow" />
          <Text c="dimmed">Loading project...</Text>
        </Stack>
      </Container>
    );
  }

  const hasReadyPanelsWithImages = project.chapters.some((ch) =>
    ch.panels.some((p) => p.status === 'Ready' && p.imageUrl)
  );

  const totalPanelCount = project.chapters.reduce((sum, ch) => sum + ch.panels.length, 0);

  // Detail drawer data
  const detailPanel = detailPanelId
    ? project.chapters.flatMap((ch) => ch.panels).find((p) => p.id === detailPanelId)
    : null;
  const detailPanelIndex =
    detailPanel && activeChapter
      ? activeChapter.panels.findIndex((p) => p.id === detailPanel.id)
      : -1;

  return (
    <>
      <Meta title={`${project.name} - Civitai Comics`} canonical={`/comics/project/${projectId}`} />

      <Container size="xl" py="xl">
        <Stack gap="xl">
          {/* ── Header card ─────────────────────────── */}
          <div className={clsx(styles.headerCard, styles.gradientTopBorder)}>
            <div className={styles.headerImage} onClick={() => openSettings()}>
              {project.coverImage?.url ? (
                <img src={getEdgeUrl(project.coverImage.url, { width: 160 })} alt={project.name} />
              ) : (
                <IconPhoto size={24} style={{ color: '#909296' }} />
              )}
            </div>

            <div className={styles.headerContent}>
              <Group gap="xs" mb={4}>
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  component={Link}
                  href={
                    currentUser?.username
                      ? `/user/${currentUser.username}/comics`
                      : '/comics'
                  }
                  c="dimmed"
                >
                  <IconArrowLeft size={16} />
                </ActionIcon>
                <Title order={3} style={{ fontWeight: 700 }} lineClamp={1}>
                  {project.name}
                </Title>
              </Group>

              {project.description && (
                <Text size="sm" c="dimmed" lineClamp={2} mb={8}>
                  {project.description}
                </Text>
              )}

              <div className="flex gap-3 items-center">
                <span className={styles.statPill}>
                  <span className={styles.statDot} />
                  {project.chapters.length}{' '}
                  {project.chapters.length === 1 ? 'chapter' : 'chapters'}
                </span>
                <span className={styles.statPill}>
                  <span className={styles.statDot} />
                  {totalPanelCount} {totalPanelCount === 1 ? 'panel' : 'panels'}
                </span>
                {(() => {
                  const nsfw = getNsfwLabel(project.nsfwLevel);
                  return nsfw ? (
                    <Badge size="xs" color={nsfw.color} variant="filled">
                      {nsfw.label}
                    </Badge>
                  ) : null;
                })()}
              </div>
            </div>

            <div className={styles.headerActions}>
              <ActionIcon variant="subtle" size="lg" onClick={() => openSettings()} c="dimmed">
                <IconSettings size={20} />
              </ActionIcon>
              <button
                className={styles.gradientBtn}
                onClick={() => router.push(`/comics/${projectId}/${slugit(project.name)}`)}
                disabled={!hasReadyPanelsWithImages}
              >
                <IconBook size={16} />
                Read
              </button>
            </div>
          </div>

          {/* ── Main layout ─────────────────────────── */}
          <div className={styles.workspaceGrid}>
            {/* ── Sidebar: References ─────────────── */}
            <div className={styles.sidebarSection}>
              <div className={styles.sidebarTitle}>
                <span>References</span>
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  component={Link}
                  href={`/comics/project/${projectId}/character`}
                  color="yellow"
                >
                  <IconPlus size={16} />
                </ActionIcon>
              </div>

              <Stack gap={8}>
                {allReferences.length === 0 ? (
                  <div className="flex flex-col items-center py-8 text-center">
                    <IconUser size={32} style={{ color: '#605e6e', marginBottom: 12 }} />
                    <Text size="xs" c="dimmed" mb="md">
                      References help maintain character consistency across panels. Optional — you
                      can generate panels without them.
                    </Text>
                    <button
                      className={styles.gradientBtn}
                      onClick={() => router.push(`/comics/project/${projectId}/character`)}
                    >
                      <IconPlus size={14} />
                      Add Reference
                    </button>
                  </div>
                ) : (
                  allReferences.map((ref) => (
                    <ReferenceSidebarItem
                      key={ref.id}
                      character={ref}
                      projectId={projectId}
                      referenceImageMap={referenceImageMap}
                      onDelete={handleDeleteReference}
                      getStatusDotClass={getStatusDotClass}
                      getStatusLabel={getStatusLabel}
                    />
                  ))
                )}
              </Stack>
            </div>

            {/* ── Sidebar: Chapters ───────────────── */}
            <div id="chapters-sidebar" className={styles.sidebarSection}>
              <div className={styles.sidebarTitle}>
                <span>Chapters</span>
              </div>

              <div className={styles.chapterSidebar}>
                <DndContext
                  sensors={chapterSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleChapterDragEnd}
                >
                  <SortableContext items={project.chapters.map((ch) => ch.position)}>
                    {project.chapters.map((chapter) => {
                      const isActive =
                        (activeChapterPosition ?? project.chapters[0]?.position) ===
                        chapter.position;
                      const panelCount = chapter.panels.length;
                      const eaConfig = chapter.earlyAccessConfig as {
                        buzzPrice: number;
                        timeframe: number;
                      } | null;
                      const isEarlyAccess =
                        chapter.status === ComicChapterStatus.Published &&
                        eaConfig != null &&
                        chapter.earlyAccessEndsAt != null &&
                        new Date(chapter.earlyAccessEndsAt) > new Date();
                      const isDeleting =
                        deleteChapterMutation.isLoading &&
                        deleteChapterMutation.variables?.chapterPosition === chapter.position;
                      const isUpdating =
                        (updateChapterMutation.isLoading &&
                          updateChapterMutation.variables?.chapterPosition === chapter.position) ||
                        (updateChapterEaMutation.isLoading &&
                          updateChapterEaMutation.variables?.chapterPosition === chapter.position);
                      const isBusy = isDeleting || isUpdating;

                      return (
                        <SortableChapter
                          key={`${chapter.projectId}-${chapter.position}`}
                          id={chapter.position}
                        >
                          <div
                            className={clsx(
                              styles.chapterItem,
                              isActive && styles.chapterItemActive
                            )}
                            style={
                              isDeleting ? { opacity: 0.5, pointerEvents: 'none' } : undefined
                            }
                            onClick={() => setActiveChapterPosition(chapter.position)}
                          >
                            <span className={styles.chapterItemNumber}>
                              {isBusy ? (
                                <Loader size={12} />
                              ) : (
                                <IconGripVertical size={12} />
                              )}
                            </span>
                            <div className={styles.chapterItemInfo}>
                              <p className={styles.chapterItemName}>
                                {chapter.name}
                                {isEarlyAccess && (
                                  <IconLock
                                    size={11}
                                    className="inline-block ml-1 opacity-60"
                                    style={{
                                      verticalAlign: 'middle',
                                      color: 'var(--mantine-color-yellow-5)',
                                    }}
                                  />
                                )}
                              </p>
                              <div
                                className={styles.chapterItemCount}
                                style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                              >
                                <Tooltip
                                  label={
                                    chapter.status === ComicChapterStatus.Scheduled
                                      ? `Scheduled · ${chapter.publishedAt ? new Date(chapter.publishedAt).toLocaleDateString() : ''}`
                                      : chapter.status === ComicChapterStatus.Published
                                      ? isEarlyAccess
                                        ? `Early Access · ${eaConfig!.buzzPrice} Buzz`
                                        : 'Published'
                                      : 'Draft'
                                  }
                                  withArrow
                                  position="right"
                                >
                                  <span
                                    className="inline-block w-1.5 h-1.5 rounded-full"
                                    style={{
                                      background: chapter.status === ComicChapterStatus.Scheduled
                                        ? 'var(--mantine-color-blue-5)'
                                        : isEarlyAccess
                                        ? 'var(--mantine-color-yellow-5)'
                                        : chapter.status === ComicChapterStatus.Published
                                        ? 'var(--mantine-color-green-5)'
                                        : 'var(--mantine-color-gray-5)',
                                    }}
                                  />
                                </Tooltip>
                                <span>
                                  {panelCount} {panelCount === 1 ? 'panel' : 'panels'}
                                </span>
                                {(() => {
                                  const nsfw = getNsfwLabel(chapter.nsfwLevel);
                                  return nsfw ? (
                                    <Badge size="xs" color={nsfw.color} variant="filled" ml={2}>
                                      {nsfw.label}
                                    </Badge>
                                  ) : null;
                                })()}
                              </div>
                            </div>
                            <span className={styles.chapterItemActions}>
                              <ActionIcon
                                variant="transparent"
                                size="xs"
                                c="dimmed"
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation();
                                  handleOpenChapterSettings(chapter);
                                }}
                              >
                                <IconSettings size={12} />
                              </ActionIcon>
                            </span>
                          </div>
                        </SortableChapter>
                      );
                    })}
                  </SortableContext>
                </DndContext>

                <button
                  className={styles.chapterAddBtn}
                  onClick={() => createChapterMutation.mutate({ projectId })}
                  disabled={createChapterMutation.isLoading}
                >
                  {createChapterMutation.isLoading ? (
                    <Loader size={14} />
                  ) : (
                    <IconPlus size={14} />
                  )}
                  {createChapterMutation.isLoading ? 'Adding...' : 'Add Chapter'}
                </button>

                {activeReferences.length > 0 && (
                  <button
                    className={styles.gradientBtn}
                    style={{ padding: '8px 12px', fontSize: 13, width: '100%' }}
                    onClick={openSmartModal}
                  >
                    <IconSparkles size={14} />
                    Smart Create
                  </button>
                )}
              </div>
            </div>

            {/* ── Main: Panels ───────────────────── */}
            <div>
              {/* Active chapter title + publish toggle */}
              {activeChapter &&
                (() => {
                  const activeEaConfig = activeChapter.earlyAccessConfig as {
                    buzzPrice: number;
                    timeframe: number;
                  } | null;
                  const isActiveEarlyAccess =
                    activeChapter.status === ComicChapterStatus.Published &&
                    activeEaConfig != null &&
                    activeChapter.earlyAccessEndsAt != null &&
                    new Date(activeChapter.earlyAccessEndsAt) > new Date();
                  const isPublishing =
                    (publishChapterMutation.isLoading &&
                      publishChapterMutation.variables?.chapterPosition ===
                        activeChapter.position) ||
                    (unpublishChapterMutation.isLoading &&
                      unpublishChapterMutation.variables?.chapterPosition ===
                        activeChapter.position);
                  const isDraft = activeChapter.status === ComicChapterStatus.Draft;
                  const isScheduled = activeChapter.status === ComicChapterStatus.Scheduled;

                  return (
                    <Group justify="space-between" align="center" mb="md">
                      <Group gap="sm">
                        <Title order={4} style={{ fontWeight: 700 }}>
                          {activeChapter.name}
                        </Title>
                        <Badge
                          size="sm"
                          variant="light"
                          color={
                            isScheduled
                              ? 'blue'
                              : isActiveEarlyAccess
                              ? 'yellow'
                              : isDraft
                              ? 'gray'
                              : 'green'
                          }
                          leftSection={
                            isScheduled
                              ? <IconCalendar size={10} />
                              : isActiveEarlyAccess
                              ? <IconLock size={10} />
                              : undefined
                          }
                        >
                          {isScheduled
                            ? `Scheduled · ${activeChapter.publishedAt ? new Date(activeChapter.publishedAt).toLocaleDateString() : ''}`
                            : isActiveEarlyAccess
                            ? `Early Access · ${activeEaConfig!.buzzPrice} Buzz`
                            : isDraft
                            ? 'Draft'
                            : 'Published'}
                        </Badge>
                      </Group>
                      <Group gap="xs">
                        {activeChapter.panels.length > 0 && (
                          <Button
                            size="xs"
                            variant="light"
                            leftSection={<IconEye size={14} />}
                            component={Link}
                            href={`/comics/project/${projectId}/read`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Preview
                          </Button>
                        )}
                        {isDraft && (
                          <Tooltip label="Publish with Early Access pricing">
                            <Button
                              size="xs"
                              variant="light"
                              color="yellow"
                              leftSection={<IconLock size={14} />}
                              disabled={activeChapter.panels.length === 0}
                              loading={isPublishing}
                              onClick={() => {
                                setActiveChapterPosition(activeChapter.position);
                                setPublishEaInitial(true);
                                openPublishModal();
                              }}
                            >
                              Early Access
                            </Button>
                          </Tooltip>
                        )}
                        <Tooltip
                          label="Add panels before publishing"
                          disabled={!isDraft || activeChapter.panels.length > 0}
                        >
                          <Button
                            size="xs"
                            variant={isDraft ? 'filled' : 'light'}
                            color={isDraft ? 'green' : isScheduled ? 'blue' : 'yellow'}
                            leftSection={
                              isDraft ? <IconWorld size={14} /> : isScheduled ? <IconCalendar size={14} /> : <IconEyeOff size={14} />
                            }
                            disabled={isDraft && activeChapter.panels.length === 0}
                            loading={isPublishing}
                            onClick={() =>
                              handleTogglePublish(activeChapter.position, activeChapter.status)
                            }
                          >
                            {isDraft ? 'Publish' : isScheduled ? 'Cancel Schedule' : 'Unpublish'}
                          </Button>
                        </Tooltip>
                      </Group>
                    </Group>
                  );
                })()}

              {activeChapter && activeChapter.panels.length === 0 && (
                <div className="flex flex-col items-center py-12 text-center">
                  <IconPhoto size={48} style={{ color: '#605e6e', marginBottom: 16 }} />
                  <Text c="dimmed" mb="md">
                    No panels yet. Create your first panel!
                  </Text>
                  <Text c="dimmed" size="xs" maw={360}>
                    Use <b>Generate</b> to create panels from a text prompt, or <b>Enhance</b> to
                    transform an existing image into a comic panel. Add <b>References</b> to
                    maintain character consistency across panels.
                  </Text>
                </div>
              )}

              {/* Panel grid */}
              <DndContext
                sensors={panelSensors}
                collisionDetection={closestCenter}
                onDragEnd={handlePanelDragEnd}
              >
                <SortableContext items={(activeChapter?.panels ?? []).map((p) => p.id)}>
                  <div
                    className="grid gap-4"
                    style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' }}
                  >
                    {(activeChapter?.panels ?? []).map((panel, index) => (
                      <SortablePanel key={panel.id} id={panel.id}>
                        <PanelCard
                          panel={panel}
                          position={index + 1}
                          referenceNames={
                            (panel.references ?? [])
                              .map((r: { referenceId: number }) =>
                                referenceNameMap.get(r.referenceId)
                              )
                              .filter(Boolean) as string[]
                          }
                          onDelete={() => deletePanelMutation.mutate({ panelId: panel.id })}
                          onRegenerate={() => handleRegenerate(panel as any)}
                          onInsertAfter={() => {
                            setInsertAtPosition(index + 1);
                            openPanelModal();
                          }}
                          onClick={() => setDetailPanelId(panel.id)}
                          onSketchEdit={() => handleSketchEdit(panel as any)}
                          onEnhance={() => handleEnhanceExisting(panel as any)}
                        />
                      </SortablePanel>
                    ))}

                    {/* Add panel button */}
                    {activeChapter && (
                      <button className={styles.addPanelBtn} onClick={openPanelModal}>
                        <IconPlus size={28} />
                      </button>
                    )}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          </div>
        </Stack>
      </Container>

      {/* ── Mobile: floating chapter nav button ──── */}
      <ActionIcon
        className={styles.mobileChapterBtn}
        variant="filled"
        color="dark"
        size="xl"
        radius="xl"
        onClick={() =>
          document.getElementById('chapters-sidebar')?.scrollIntoView({ behavior: 'smooth' })
        }
      >
        <IconBook size={18} />
      </ActionIcon>

      {/* ── Extracted components ──────────────────── */}
      <PanelDetailDrawer
        detailPanelId={detailPanelId}
        setDetailPanelId={setDetailPanelId}
        detailPanel={detailPanel as any}
        detailPanelIndex={detailPanelIndex}
        referenceNameMap={referenceNameMap}
        onRegenerate={handleDrawerRegenerate}
        onInsertAfter={handleDrawerInsertAfter}
        onDelete={(panelId) => deletePanelMutation.mutate({ panelId })}
        onSketchEdit={handleSketchEdit}
        onEnhance={handleDrawerEnhance}
      />

      <PanelModal
        opened={panelModalOpened}
        onClose={handlePanelModalClose}
        prompt={prompt}
        setPrompt={setPrompt}
        enhancePrompt={enhancePrompt}
        setEnhancePrompt={setEnhancePrompt}
        useContext={useContext}
        setUseContext={setUseContext}
        includePreviousImage={includePreviousImage}
        setIncludePreviousImage={setIncludePreviousImage}
        aspectRatio={aspectRatio}
        setAspectRatio={setAspectRatio}
        selectedImageIds={selectedImageIds}
        setSelectedImageIds={setSelectedImageIds}
        effectiveModel={effectiveModel}
        onModelChange={handleModelChange}
        activeAspectRatios={activeAspectRatios}
        mentionRefs={mentionRefs}
        mentionedReferences={mentionedReferences}
        needsImageSelection={needsImageSelection}
        refImageBudget={refImageBudget}
        regeneratingPanelId={regeneratingPanelId}
        insertAtPosition={insertAtPosition}
        activeChapterPanelCount={activeChapter?.panels.length ?? 0}
        panelCost={panelCost}
        enhanceCost={enhanceCost}
        isSubmitting={isSubmitting}
        onGeneratePanel={handleGeneratePanel}
        onEnhancePanel={handleEnhancePanel}
        onBulkCreate={handleBulkCreate}
        onImportSubmit={handleImportSubmit}
        isCreatePending={createPanelMutation.isPending}
        isEnhancePending={enhancePanelMutation.isPending}
        isBulkPending={bulkCreateMutation.isPending}
        initialEnhanceSource={enhanceExistingSource}
      />

      <SmartCreateModal
        opened={smartModalOpened}
        onClose={closeSmartModal}
        references={mentionRefs}
        planCost={planCost}
        panelCost={panelCost}
        enhanceCost={enhanceCost}
        effectiveModel={effectiveModel}
        activeAspectRatios={activeAspectRatios}
        onModelChange={handleModelChange}
        onPlanPanels={(story) =>
          planPanelsMutation.mutate({ projectId, storyDescription: story })
        }
        isPlanningPanels={planPanelsMutation.isPending}
        planError={planPanelsMutation.isError ? (planPanelsMutation.error?.message ?? 'Failed to plan panels') : null}
        plannedPanels={planPanelsMutation.data?.panels ?? null}
        onCreateChapter={(data) =>
          smartCreateMutation.mutate({
            projectId,
            chapterName: data.chapterName,
            storyDescription: data.storyDescription,
            panels: data.panels,
            enhance: data.enhance,
            aspectRatio: data.aspectRatio,
            baseModel: generationModel,
          })
        }
        isCreating={smartCreateMutation.isPending}
        createError={smartCreateMutation.isError ? (smartCreateMutation.error?.message ?? 'Failed to create chapter') : null}
      />

      <ChapterSettingsModal
        opened={chapterSettingsOpened}
        onClose={closeChapterSettings}
        chapter={chapterSettingsTarget}
        canDelete={project.chapters.length > 1}
        onSave={handleSaveChapterSettings}
        onDelete={handleDeleteChapter}
        isSaving={updateChapterMutation.isLoading || updateChapterEaMutation.isLoading}
        isDeleting={deleteChapterMutation.isLoading}
      />

      <PublishModal
        opened={publishModalOpened}
        onClose={closePublishModal}
        onPublish={handleConfirmPublish}
        isLoading={publishChapterMutation.isLoading}
        initialEaEnabled={publishEaInitial}
      />

      <ProjectSettingsModal
        opened={settingsOpened}
        onClose={closeSettings}
        project={{
          name: project.name,
          description: project.description,
          genre: (project as any).genre,
          baseModel: project.baseModel,
          coverImage: project.coverImage,
          heroImage: (project as any).heroImage,
          heroImagePosition: (project as any).heroImagePosition,
        }}
        onSave={(data) => updateProjectMutation.mutate({ id: projectId, ...data, baseModel: data.baseModel as any })}
        onDeleteProject={() => deleteProjectMutation.mutate({ id: projectId })}
        isSaving={updateProjectMutation.isLoading}
      />
    </>
  );
}

export default Page(ProjectWorkspace);
