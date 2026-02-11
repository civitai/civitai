import {
  ActionIcon,
  Button,
  Container,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBook,
  IconBug,
  IconPencil,
  IconPhoto,
  IconPhotoUp,
  IconPlus,
  IconRefreshDot,
  IconSettings,
  IconSparkles,
  IconTrash,
  IconUpload,
  IconUser,
  IconWand,
  IconX,
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
import { HeroPositionPicker } from '~/components/Comics/HeroPositionPicker';
import { MentionTextarea } from '~/components/Comics/MentionTextarea';
import { PanelCard, SortablePanel } from '~/components/Comics/PanelCard';
import { PanelDebugModal } from '~/components/Comics/PanelDebugModal';
import { ReferenceSidebarItem } from '~/components/Comics/ReferenceSidebarItem';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { formatGenreLabel } from '~/utils/comic-helpers';
import { ComicGenre } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import styles from './ProjectWorkspace.module.scss';

const ImageSelectModal = dynamic(() => import('~/components/Training/Form/ImageSelectModal'), {
  ssr: false,
});

const genreOptions = Object.entries(ComicGenre).map(([key, value]) => ({
  value,
  label: formatGenreLabel(key),
}));

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
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
  const { id } = router.query;
  const projectId = Number(id);

  const [panelModalOpened, { open: openPanelModal, close: closePanelModal }] = useDisclosure(false);
  const [debugModalOpened, { open: openDebugModal, close: closeDebugModal }] = useDisclosure(false);
  const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
  const [debugPanelId, setDebugPanelId] = useState<number | null>(null);
  const [prompt, setPrompt] = useState('');
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [useContext, setUseContext] = useState(true);
  const [includePreviousImage, setIncludePreviousImage] = useState(false);
  const [activeChapterPosition, setActiveChapterPosition] = useState<number | null>(null);
  const [regeneratingPanelId, setRegeneratingPanelId] = useState<number | null>(null);

  // Panel mode: Generate (prompt from scratch) vs Enhance (start from image)
  const [panelMode, setPanelMode] = useState<'generate' | 'enhance'>('generate');
  const [enhanceSourceImage, setEnhanceSourceImage] = useState<{
    url: string;
    previewUrl: string;
    width: number;
    height: number;
  } | null>(null);
  const [enhanceUploading, setEnhanceUploading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const {
    uploadToCF: uploadEnhanceToCF,
    files: enhanceUploadFiles,
    resetFiles: resetEnhanceFiles,
  } = useCFImageUpload();

  // Chapter rename state
  const [editingChapterPosition, setEditingChapterPosition] = useState<number | null>(null);
  const [editChapterName, setEditChapterName] = useState('');
  const chapterInputRef = useRef<HTMLInputElement>(null);

  // Settings modal state
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCoverUrl, setEditCoverUrl] = useState<string | null>(null);
  const [editCoverImageId, setEditCoverImageId] = useState<number | null>(null);
  const [editGenre, setEditGenre] = useState<string | null>(null);
  const [editHeroUrl, setEditHeroUrl] = useState<string | null>(null);
  const [editHeroImageId, setEditHeroImageId] = useState<number | null>(null);
  const [editHeroPosition, setEditHeroPosition] = useState(50);
  const { uploadToCF, files: coverUploadFiles, resetFiles: resetCoverFiles } = useCFImageUpload();
  const {
    uploadToCF: uploadHeroToCF,
    files: heroUploadFiles,
    resetFiles: resetHeroFiles,
  } = useCFImageUpload();

  // Panel detail drawer state
  const [detailPanelId, setDetailPanelId] = useState<number | null>(null);
  // Insert-at-position state for adding panels between existing ones
  const [insertAtPosition, setInsertAtPosition] = useState<number | null>(null);

  // Smart Create modal state
  const [smartModalOpened, { open: openSmartModal, close: closeSmartModal }] = useDisclosure(false);
  const [smartStep, setSmartStep] = useState<'input' | 'review'>('input');
  const [smartChapterName, setSmartChapterName] = useState('New Chapter');
  const [smartStory, setSmartStory] = useState('');
  const [smartPanels, setSmartPanels] = useState<{ prompt: string }[]>([]);
  const [smartEnhance, setSmartEnhance] = useState(true);

  const panelSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const {
    data: project,
    isLoading,
    refetch,
  } = trpc.comics.getProject.useQuery({ id: projectId }, { enabled: projectId > 0 });

  // Dynamic cost estimate from orchestrator
  const { data: costEstimate } = trpc.comics.getPanelCostEstimate.useQuery(undefined, {
    staleTime: 5 * 60 * 1000, // cache for 5 minutes
  });
  const panelCost = costEstimate?.cost ?? 25; // fallback to 25 if unavailable

  // Set active chapter to first chapter on load
  useEffect(() => {
    if (project?.chapters?.length && activeChapterPosition == null) {
      setActiveChapterPosition(project.chapters[0].position);
    }
  }, [project?.chapters, activeChapterPosition]);

  // All user references (global — not project-specific)
  const allReferences = useMemo(() => project?.references ?? [], [project?.references]);

  // Build reference image map
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

  const handleMutationError = (error: any) => {
    showErrorNotification({ error, title: 'Something went wrong' });
  };

  const createPanelMutation = trpc.comics.createPanel.useMutation({
    onSuccess: () => {
      closePanelModal();
      setPrompt('');
      setRegeneratingPanelId(null);
      setInsertAtPosition(null);
      setEnhanceSourceImage(null);
      setPanelMode('generate');
      refetch();
    },
    onError: handleMutationError,
  });

  const enhancePanelMutation = trpc.comics.enhancePanel.useMutation({
    onSuccess: () => {
      closePanelModal();
      setPrompt('');
      setEnhanceSourceImage(null);
      setInsertAtPosition(null);
      setPanelMode('generate');
      resetEnhanceFiles();
      refetch();
    },
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
    onSuccess: () => refetch(),
    onError: handleMutationError,
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

  const planPanelsMutation = trpc.comics.planChapterPanels.useMutation({
    onSuccess: (data) => {
      setSmartPanels(data.panels);
      setSmartStep('review');
    },
    onError: handleMutationError,
  });

  const smartCreateMutation = trpc.comics.smartCreateChapter.useMutation({
    onSuccess: (data) => {
      closeSmartModal();
      setActiveChapterPosition(data.position);
      resetSmartState();
      refetch();
    },
    onError: handleMutationError,
  });

  const utils = trpc.useUtils();

  // Get active chapter's panels
  const activeChapter = useMemo(
    () =>
      project?.chapters?.find((ch) => ch.position === activeChapterPosition) ??
      project?.chapters?.[0],
    [project?.chapters, activeChapterPosition]
  );

  // Poll for panels actively generating
  const generatingPanelIds = useMemo(
    () => (activeChapter?.panels ?? []).filter((p) => p.status === 'Generating').map((p) => p.id),
    [activeChapter?.panels]
  );

  useEffect(() => {
    if (generatingPanelIds.length === 0) return;
    const interval = setInterval(async () => {
      try {
        const results = await Promise.all(
          generatingPanelIds.map((panelId) => utils.comics.pollPanelStatus.fetch({ panelId }))
        );
        if (results.some((r) => r.status === 'Ready' || r.status === 'Failed')) refetch();
      } catch {
        /* ignore */
      }
    }, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generatingPanelIds.join(','), utils, refetch]);

  // Poll for references in Pending state (waiting for images)
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

  // Focus chapter rename input
  useEffect(() => {
    if (editingChapterPosition != null && chapterInputRef.current) {
      chapterInputRef.current.focus();
      chapterInputRef.current.select();
    }
  }, [editingChapterPosition]);

  // Build reference name map for panel cards
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

  const anyRefHasImages = useMemo(
    () => activeReferences.some((c) => ((c as any).images?.length ?? 0) > 0),
    [activeReferences]
  );

  // References for MentionTextarea autocomplete
  const mentionRefs = useMemo(
    () => activeReferences.map((c) => ({ id: c.id, name: c.name })),
    [activeReferences]
  );

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

  // Find panel for detail drawer
  const detailPanel = detailPanelId
    ? project.chapters.flatMap((ch) => ch.panels).find((p) => p.id === detailPanelId)
    : null;
  const detailPanelIndex =
    detailPanel && activeChapter
      ? activeChapter.panels.findIndex((p) => p.id === detailPanel.id)
      : -1;

  const handlePanelDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id || !activeChapter) return;
    const panels = activeChapter.panels;
    const oldIndex = panels.findIndex((p) => p.id === active.id);
    const newIndex = panels.findIndex((p) => p.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(panels, oldIndex, newIndex);
    reorderPanelsMutation.mutate({
      projectId,
      chapterPosition: activeChapter.position,
      panelIds: reordered.map((p) => p.id),
    });
  };

  const handlePanelModalClose = () => {
    closePanelModal();
    setRegeneratingPanelId(null);
    setInsertAtPosition(null);
    setEnhanceSourceImage(null);
    setEnhanceUploading(false);
    setPanelMode('generate');
    setPrompt('');
    setUseContext(true);
    setIncludePreviousImage(false);
    resetEnhanceFiles();
  };

  const handleGeneratePanel = async () => {
    if (!prompt.trim() || !activeChapter || isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (regeneratingPanelId) {
        await deletePanelMutation.mutateAsync({ panelId: regeneratingPanelId });
      }
      createPanelMutation.mutate({
        projectId,
        chapterPosition: activeChapter.position,
        prompt: prompt.trim(),
        enhance: enhancePrompt,
        useContext,
        includePreviousImage,
        ...(insertAtPosition != null ? { position: insertAtPosition } : {}),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnhancePanel = async () => {
    if (!activeChapter || !enhanceSourceImage || isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (regeneratingPanelId) {
        await deletePanelMutation.mutateAsync({ panelId: regeneratingPanelId });
      }
      enhancePanelMutation.mutate({
        projectId,
        chapterPosition: activeChapter.position,
        sourceImageUrl: enhanceSourceImage.url,
        sourceImageWidth: enhanceSourceImage.width,
        sourceImageHeight: enhanceSourceImage.height,
        prompt: prompt.trim() || undefined,
        enhance: enhancePrompt,
        useContext,
        includePreviousImage,
        ...(insertAtPosition != null ? { position: insertAtPosition } : {}),
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnhanceImageDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const file = files[0];
    setEnhanceUploading(true);
    try {
      // Get image dimensions
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
      }).catch(() => ({ width: 512, height: 512 })); // fallback dimensions on error

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
          // Generator images are ephemeral — fetch the blob and upload to CF
          // so the image persists and can be ingested/scanned
          try {
            const edgeUrl = getEdgeUrl(img.url, { original: true }) ?? img.url;
            const response = await fetch(edgeUrl);
            const blob = await response.blob();
            const file = new File([blob], `enhance_${Date.now()}.jpg`, { type: blob.type });
            const result = await uploadEnhanceToCF(file);
            setEnhanceSourceImage({
              url: result.id,
              previewUrl: getEdgeUrl(result.id, { width: 400 }) ?? result.id,
              width,
              height,
            });
          } catch (err) {
            console.error('Failed to upload generator image:', err);
            // Fallback: use the URL directly (will still work but may expire)
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

  const handleSaveChapterName = () => {
    if (editingChapterPosition == null || !editChapterName.trim()) {
      setEditingChapterPosition(null);
      return;
    }
    updateChapterMutation.mutate(
      { projectId, chapterPosition: editingChapterPosition, name: editChapterName.trim() },
      { onSettled: () => setEditingChapterPosition(null) }
    );
  };

  const handleDeleteChapter = (chapterPosition: number, chapterName: string) => {
    if (project.chapters.length <= 1) return;
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

  const handleOpenSettings = () => {
    setEditName(project.name);
    setEditDescription(project.description ?? '');
    setEditGenre((project as any).genre ?? null);
    setEditCoverUrl(project.coverImage?.url ?? null);
    setEditCoverImageId(project.coverImage?.id ?? null);
    setEditHeroUrl((project as any).heroImage?.url ?? null);
    setEditHeroImageId((project as any).heroImage?.id ?? null);
    setEditHeroPosition((project as any).heroImagePosition ?? 50);
    resetCoverFiles();
    resetHeroFiles();
    openSettings();
  };

  const handleSaveSettings = () => {
    updateProjectMutation.mutate({
      id: projectId,
      name: editName.trim() || undefined,
      description: editDescription.trim() || null,
      genre:
        editGenre !== ((project as any).genre ?? null)
          ? (editGenre as ComicGenre) ?? null
          : undefined,
      // Pass URL for new uploads (backend creates Image record), or null to clear
      coverUrl: editCoverUrl !== (project.coverImage?.url ?? null) ? editCoverUrl : undefined,
      heroUrl: editHeroUrl !== ((project as any).heroImage?.url ?? null) ? editHeroUrl : undefined,
      heroImagePosition:
        editHeroPosition !== ((project as any).heroImagePosition ?? 50)
          ? editHeroPosition
          : undefined,
    });
  };

  const handleCoverDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const result = await uploadToCF(files[0]);
    setEditCoverUrl(result.id);
    setEditCoverImageId(null); // New upload — backend will create Image record
  };

  const handleHeroDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const result = await uploadHeroToCF(files[0]);
    setEditHeroUrl(result.id);
    setEditHeroImageId(null); // New upload — backend will create Image record
  };

  const resetSmartState = () => {
    setSmartStep('input');
    setSmartChapterName('New Chapter');
    setSmartStory('');
    setSmartPanels([]);
    setSmartEnhance(true);
  };

  const handlePlanPanels = () => {
    if (!smartStory.trim()) return;
    planPanelsMutation.mutate({ projectId, storyDescription: smartStory.trim() });
  };

  const handleSmartCreate = () => {
    if (smartPanels.length === 0) return;
    smartCreateMutation.mutate({
      projectId,
      chapterName: smartChapterName.trim() || 'New Chapter',
      storyDescription: smartStory.trim(),
      panels: smartPanels.filter((p) => p.prompt.trim()),
      enhance: smartEnhance,
    });
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

  return (
    <>
      <Meta title={`${project.name} - Civitai Comics`} />

      <Container size="xl" py="xl">
        <Stack gap="xl">
          {/* ── Header card ─────────────────────────── */}
          <div className={clsx(styles.headerCard, styles.gradientTopBorder)}>
            <div className={styles.headerImage} onClick={handleOpenSettings}>
              {project.coverImage?.url ? (
                <img src={getEdgeUrl(project.coverImage.url, { width: 160 })} alt={project.name} />
              ) : (
                <IconPhoto size={24} style={{ color: '#909296' }} />
              )}
            </div>

            <div className={styles.headerContent}>
              <Group gap="xs" mb={4}>
                <ActionIcon variant="subtle" size="sm" component={Link} href="/comics" c="dimmed">
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

              <div className="flex gap-3">
                <span className={styles.statPill}>
                  <span className={styles.statDot} />
                  {project.chapters.length} {project.chapters.length === 1 ? 'chapter' : 'chapters'}
                </span>
                <span className={styles.statPill}>
                  <span className={styles.statDot} />
                  {totalPanelCount} {totalPanelCount === 1 ? 'panel' : 'panels'}
                </span>
              </div>
            </div>

            <div className={styles.headerActions}>
              <ActionIcon variant="subtle" size="lg" onClick={handleOpenSettings} c="dimmed">
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
                    <Text size="sm" c="dimmed" mb="md">
                      No references yet
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
            <div className={styles.sidebarSection}>
              <div className={styles.sidebarTitle}>
                <span>Chapters</span>
              </div>

              <div className={styles.chapterSidebar}>
                {project.chapters.map((chapter, idx) => {
                  const isActive =
                    (activeChapterPosition ?? project.chapters[0]?.position) === chapter.position;
                  const panelCount = chapter.panels.length;

                  return (
                    <div
                      key={`${chapter.projectId}-${chapter.position}`}
                      className={clsx(styles.chapterItem, isActive && styles.chapterItemActive)}
                      onClick={() => {
                        if (editingChapterPosition !== chapter.position)
                          setActiveChapterPosition(chapter.position);
                      }}
                    >
                      <span className={styles.chapterItemNumber}>{idx + 1}</span>
                      <div className={styles.chapterItemInfo}>
                        {editingChapterPosition === chapter.position ? (
                          <input
                            ref={chapterInputRef}
                            className={styles.chapterItemInput}
                            value={editChapterName}
                            onChange={(e) => setEditChapterName(e.target.value)}
                            onBlur={handleSaveChapterName}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveChapterName();
                              if (e.key === 'Escape') setEditingChapterPosition(null);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <p className={styles.chapterItemName}>{chapter.name}</p>
                            <p className={styles.chapterItemCount}>
                              {panelCount} {panelCount === 1 ? 'panel' : 'panels'}
                            </p>
                          </>
                        )}
                      </div>
                      <span className={styles.chapterItemActions}>
                        <ActionIcon
                          variant="transparent"
                          size="xs"
                          c="dimmed"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            setEditingChapterPosition(chapter.position);
                            setEditChapterName(chapter.name);
                          }}
                        >
                          <IconPencil size={12} />
                        </ActionIcon>
                        {project.chapters.length > 1 && (
                          <ActionIcon
                            variant="transparent"
                            size="xs"
                            color="red"
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              handleDeleteChapter(chapter.position, chapter.name);
                            }}
                          >
                            <IconX size={12} />
                          </ActionIcon>
                        )}
                      </span>
                    </div>
                  );
                })}

                <button
                  className={styles.chapterAddBtn}
                  onClick={() => createChapterMutation.mutate({ projectId })}
                >
                  <IconPlus size={14} />
                  Add Chapter
                </button>

                {activeReferences.length > 0 && (
                  <button
                    className={styles.gradientBtn}
                    style={{ padding: '8px 12px', fontSize: 13, width: '100%' }}
                    onClick={() => {
                      resetSmartState();
                      openSmartModal();
                    }}
                  >
                    <IconSparkles size={14} />
                    Smart Create
                  </button>
                )}
              </div>
            </div>

            {/* ── Main: Panels ───────────────────── */}
            <div>
              {/* Status messages */}
              {activeReferences.length === 0 && allReferences.length === 0 && (
                <div className="flex flex-col items-center py-12 text-center">
                  <IconPhoto size={48} style={{ color: '#605e6e', marginBottom: 16 }} />
                  <Text c="dimmed" mb="md">
                    Add a reference first to start generating panels
                  </Text>
                  <button
                    className={styles.gradientBtn}
                    onClick={() => router.push(`/comics/project/${projectId}/character`)}
                  >
                    <IconPlus size={14} />
                    Add Reference
                  </button>
                </div>
              )}

              {activeReferences.length === 0 && allReferences.length > 0 && (
                <div className="py-8 text-center">
                  <Text c="dimmed" size="sm">
                    Wait for your references to finish processing before generating panels.
                  </Text>
                </div>
              )}

              {activeReferences.length > 0 && !anyRefHasImages && (
                <div
                  className="flex items-center justify-between py-4 px-4 rounded-lg"
                  style={{ background: '#2C2E33', border: '1px solid #373A40' }}
                >
                  <Text c="dimmed" size="sm">
                    References need images before generating panels.
                  </Text>
                  <button
                    className={styles.subtleBtn}
                    onClick={() => router.push(`/comics/project/${projectId}/character`)}
                  >
                    Add References
                  </button>
                </div>
              )}

              {activeChapter &&
                activeChapter.panels.length === 0 &&
                activeReferences.length > 0 &&
                anyRefHasImages && (
                  <div className="flex flex-col items-center py-12 text-center">
                    <IconPhoto size={48} style={{ color: '#605e6e', marginBottom: 16 }} />
                    <Text c="dimmed">No panels yet. Create your first panel!</Text>
                  </div>
                )}

              {/* Active chapter title */}
              {activeChapter && (
                <Title order={4} mb="md" style={{ fontWeight: 700 }}>
                  {activeChapter.name}
                </Title>
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
                          onViewDebug={() => {
                            setDebugPanelId(panel.id);
                            openDebugModal();
                          }}
                          onRegenerate={() => {
                            const meta = panel.metadata as Record<string, any> | null;
                            setRegeneratingPanelId(panel.id);
                            setPrompt(panel.prompt);
                            setEnhancePrompt(meta?.enhanceEnabled ?? true);
                            setUseContext(meta?.useContext ?? true);
                            setIncludePreviousImage(meta?.includePreviousImage ?? false);
                            if (meta?.sourceImageUrl) {
                              setPanelMode('enhance');
                              setEnhanceSourceImage({
                                url: meta.sourceImageUrl,
                                previewUrl:
                                  getEdgeUrl(meta.sourceImageUrl, { width: 400 }) ??
                                  meta.sourceImageUrl,
                                width: meta.sourceImageWidth ?? 512,
                                height: meta.sourceImageHeight ?? 512,
                              });
                            } else {
                              setPanelMode('generate');
                            }
                            openPanelModal();
                          }}
                          onInsertAfter={() => {
                            setInsertAtPosition(index + 1);
                            openPanelModal();
                          }}
                          onClick={() => setDetailPanelId(panel.id)}
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

      {/* ── Panel Detail Drawer ──────────────────── */}
      <div
        className={clsx(styles.drawerBackdrop, detailPanel && styles.active)}
        onClick={() => setDetailPanelId(null)}
      />
      <div className={clsx(styles.drawer, detailPanel && styles.active)}>
        {detailPanel && (
          <>
            <div className={styles.drawerHeader}>
              <Title order={4} style={{ fontWeight: 700 }}>
                Panel #{detailPanelIndex >= 0 ? detailPanelIndex + 1 : '?'}
              </Title>
              <ActionIcon variant="subtle" c="dimmed" onClick={() => setDetailPanelId(null)}>
                <IconX size={20} />
              </ActionIcon>
            </div>

            <div className={styles.drawerContent}>
              {/* Image */}
              <div className={styles.drawerImageContainer}>
                {detailPanel.imageUrl ? (
                  <img src={getEdgeUrl(detailPanel.imageUrl, { width: 800 })} alt="Panel" />
                ) : (
                  <div
                    className="w-full flex items-center justify-center"
                    style={{ background: '#2C2E33', aspectRatio: '3/4' }}
                  >
                    {detailPanel.status === 'Generating' || detailPanel.status === 'Pending' ? (
                      <div className={styles.spinner} />
                    ) : (
                      <IconAlertTriangle size={32} style={{ color: '#fa5252' }} />
                    )}
                  </div>
                )}
              </div>

              {/* Status + Reference row */}
              <div className="flex items-center gap-3 flex-wrap">
                <div className={styles.detailStatusBadge}>
                  <span
                    className={clsx(styles.detailStatusDot, {
                      [styles.ready]: detailPanel.status === 'Ready',
                      [styles.generating]:
                        detailPanel.status === 'Generating' || detailPanel.status === 'Pending',
                      [styles.failed]: detailPanel.status === 'Failed',
                    })}
                  />
                  {detailPanel.status === 'Pending' ? 'Queued' : detailPanel.status}
                </div>
                {(detailPanel.references ?? []).map((r: { referenceId: number }) => {
                  const name = referenceNameMap.get(r.referenceId);
                  return name ? (
                    <span key={r.referenceId} className={styles.detailCharacterPill}>
                      <IconUser size={14} />
                      {name}
                    </span>
                  ) : null;
                })}
                <div className="flex-1" />
                <Text size="xs" c="dimmed">
                  {new Date(detailPanel.createdAt).toLocaleDateString()}
                </Text>
              </div>

              {/* Original prompt */}
              <div>
                <div className={styles.detailSectionTitle}>Original Prompt</div>
                <div className={styles.promptBox}>{detailPanel.prompt}</div>
              </div>

              {/* Enhanced prompt */}
              {detailPanel.enhancedPrompt && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={styles.detailSectionTitle} style={{ marginBottom: 0 }}>
                      Enhanced Prompt
                    </span>
                    <span className={styles.enhancedBadge}>
                      <IconSparkles size={12} />
                      Enhanced
                    </span>
                  </div>
                  <div className={clsx(styles.promptBox, styles.promptBoxEnhanced)}>
                    {detailPanel.enhancedPrompt}
                  </div>
                </div>
              )}

              {/* Error */}
              {detailPanel.errorMessage && (
                <div>
                  <div className={styles.detailSectionTitle}>Error</div>
                  <div
                    className={styles.promptBox}
                    style={{ borderColor: '#fa5252', color: '#fa5252' }}
                  >
                    {detailPanel.errorMessage}
                  </div>
                </div>
              )}

              {/* Source Image (for enhanced panels) */}
              {(detailPanel.metadata as Record<string, any> | null)?.sourceImageUrl && (
                <div>
                  <div className={styles.detailSectionTitle}>Source Image</div>
                  <div className={styles.enhanceImagePreview}>
                    <img
                      src={
                        getEdgeUrl((detailPanel.metadata as Record<string, any>).sourceImageUrl, {
                          width: 400,
                        }) ?? (detailPanel.metadata as Record<string, any>).sourceImageUrl
                      }
                      alt="Source"
                    />
                  </div>
                </div>
              )}

              {/* Generation settings */}
              {(() => {
                const meta = detailPanel.metadata as Record<string, any> | null;
                if (!meta) return null;
                return (
                  <div>
                    <div className={styles.detailSectionTitle}>Settings</div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={styles.detailCharacterPill}>
                        {meta.enhanceEnabled !== false ? 'Prompt enhanced' : 'Prompt not enhanced'}
                      </span>
                      {meta.enhanceEnabled !== false && (
                        <span className={styles.detailCharacterPill}>
                          {meta.useContext !== false
                            ? 'Previous context used'
                            : 'No previous context'}
                        </span>
                      )}
                      {meta.includePreviousImage && (
                        <span className={styles.detailCharacterPill}>
                          Previous image referenced
                        </span>
                      )}
                      {meta.sourceImageUrl && (
                        <span className={styles.detailCharacterPill}>Enhanced from image</span>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Actions */}
              <div className={styles.detailActions}>
                {(detailPanel.status === 'Ready' || detailPanel.status === 'Failed') && (
                  <button
                    className={styles.gradientBtn}
                    onClick={() => {
                      const meta = detailPanel.metadata as Record<string, any> | null;
                      setDetailPanelId(null);
                      setRegeneratingPanelId(detailPanel.id);
                      setPrompt(detailPanel.prompt);
                      setEnhancePrompt(meta?.enhanceEnabled ?? true);
                      setUseContext(meta?.useContext ?? true);
                      setIncludePreviousImage(meta?.includePreviousImage ?? false);
                      if (meta?.sourceImageUrl) {
                        setPanelMode('enhance');
                        setEnhanceSourceImage({
                          url: meta.sourceImageUrl,
                          previewUrl:
                            getEdgeUrl(meta.sourceImageUrl, { width: 400 }) ?? meta.sourceImageUrl,
                          width: meta.sourceImageWidth ?? 512,
                          height: meta.sourceImageHeight ?? 512,
                        });
                      } else {
                        setPanelMode('generate');
                      }
                      openPanelModal();
                    }}
                  >
                    <IconRefreshDot size={16} />
                    Regenerate
                  </button>
                )}
                {detailPanelIndex >= 0 && (
                  <button
                    className={styles.subtleBtn}
                    onClick={() => {
                      setDetailPanelId(null);
                      setInsertAtPosition(detailPanelIndex + 1);
                      openPanelModal();
                    }}
                  >
                    <IconPlus size={14} />
                    Insert after
                  </button>
                )}
                <button
                  className={styles.subtleBtn}
                  onClick={() => {
                    setDetailPanelId(null);
                    setDebugPanelId(detailPanel.id);
                    openDebugModal();
                  }}
                >
                  <IconBug size={14} />
                  Debug Info
                </button>
                <button
                  className={styles.dangerBtn}
                  onClick={() => {
                    openConfirmModal({
                      title: 'Delete Panel',
                      children: <Text size="sm">Are you sure you want to delete this panel?</Text>,
                      labels: { confirm: 'Delete', cancel: 'Cancel' },
                      confirmProps: { color: 'red' },
                      onConfirm: () => deletePanelMutation.mutate({ panelId: detailPanel.id }),
                    });
                  }}
                >
                  <IconTrash size={14} />
                  Delete
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Generate / Enhance Panel Modal ─────────────────── */}
      <Modal
        opened={panelModalOpened}
        onClose={handlePanelModalClose}
        title={
          regeneratingPanelId
            ? 'Regenerate Panel'
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
          </div>
        )}

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
            {activeChapter && activeChapter.panels.length > 0 && insertAtPosition !== 0 && (
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

            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                Cost: {panelCost > 0 ? `${panelCost} Buzz` : 'Estimating...'}
              </Text>
              <Group>
                <Button variant="default" onClick={handlePanelModalClose}>
                  Cancel
                </Button>
                <button
                  className={styles.gradientBtn}
                  onClick={handleGeneratePanel}
                  disabled={!prompt.trim() || isSubmitting || createPanelMutation.isPending}
                >
                  {createPanelMutation.isPending ? <Loader size={14} color="dark" /> : null}
                  {insertAtPosition != null ? 'Insert' : 'Generate'}
                </button>
              </Group>
            </Group>
          </Stack>
        ) : (
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
                  <ActionIcon
                    className={styles.enhanceImageRemove}
                    variant="filled"
                    color="dark"
                    size="sm"
                    onClick={() => {
                      setEnhanceSourceImage(null);
                      resetEnhanceFiles();
                    }}
                  >
                    <IconX size={14} />
                  </ActionIcon>
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
                {activeChapter &&
                  activeChapter.panels.length > 0 &&
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
                {activeChapter && activeChapter.panels.length > 0 && insertAtPosition !== 0 && (
                  <Switch
                    label="Reference previous panel image"
                    description="Include the previous panel's image as a reference for generation"
                    checked={includePreviousImage}
                    onChange={(e) => setIncludePreviousImage(e.currentTarget.checked)}
                  />
                )}
              </>
            )}

            <Group justify="space-between">
              <Text size="sm" c="dimmed">
                {!prompt.trim()
                  ? 'Free — panel from your image'
                  : panelCost > 0
                  ? `Cost: ${panelCost} Buzz`
                  : 'Cost: Estimating...'}
              </Text>
              <Group>
                <Button variant="default" onClick={handlePanelModalClose}>
                  Cancel
                </Button>
                <button
                  className={styles.gradientBtn}
                  onClick={handleEnhancePanel}
                  disabled={!enhanceSourceImage || isSubmitting || enhancePanelMutation.isPending}
                >
                  {enhancePanelMutation.isPending ? <Loader size={14} color="dark" /> : null}
                  {regeneratingPanelId ? 'Regenerate' : !prompt.trim() ? 'Add Panel' : 'Enhance'}
                </button>
              </Group>
            </Group>
          </Stack>
        )}
      </Modal>

      {/* ── Smart Create Modal ────────────────────── */}
      <Modal
        opened={smartModalOpened}
        onClose={() => {
          closeSmartModal();
          resetSmartState();
        }}
        title={
          smartStep === 'input' ? 'Smart Create Chapter' : `Review Panels — ${smartChapterName}`
        }
        size="lg"
      >
        {smartStep === 'input' ? (
          <Stack gap="md">
            <TextInput
              label="Chapter name"
              value={smartChapterName}
              onChange={(e) => setSmartChapterName(e.target.value)}
            />

            <MentionTextarea
              label="Describe the story or scene"
              value={smartStory}
              onChange={setSmartStory}
              references={mentionRefs}
              placeholder="A warrior discovers an ancient temple... Use @Name to reference characters"
              rows={6}
            />

            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={() => {
                  closeSmartModal();
                  resetSmartState();
                }}
              >
                Cancel
              </Button>
              <button
                className={styles.gradientBtn}
                onClick={handlePlanPanels}
                disabled={!smartStory.trim() || planPanelsMutation.isPending}
              >
                {planPanelsMutation.isPending ? (
                  <Loader size={14} color="dark" />
                ) : (
                  <IconSparkles size={14} />
                )}
                {planPanelsMutation.isPending ? 'Planning...' : 'Plan Panels'}
              </button>
            </Group>

            {planPanelsMutation.isError && (
              <Text size="sm" c="red">
                {planPanelsMutation.error?.message ?? 'Failed to plan panels'}
              </Text>
            )}
          </Stack>
        ) : (
          <Stack gap="md">
            <Text size="sm" c="dimmed">
              {smartPanels.length} panels planned
            </Text>

            <ScrollArea.Autosize mah="50vh">
              <Stack gap="sm">
                {smartPanels.map((panel, index) => (
                  <div key={index} className="flex gap-2 items-start">
                    <Text size="xs" c="dimmed" fw={600} mt={8} style={{ minWidth: 24 }}>
                      #{index + 1}
                    </Text>
                    <div className="flex-1">
                      <MentionTextarea
                        value={panel.prompt}
                        onChange={(val) => {
                          const updated = [...smartPanels];
                          updated[index] = { prompt: val };
                          setSmartPanels(updated);
                        }}
                        references={mentionRefs}
                        placeholder="Panel prompt... Use @Name for references"
                        rows={2}
                      />
                    </div>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="sm"
                      mt={8}
                      onClick={() => setSmartPanels(smartPanels.filter((_, i) => i !== index))}
                      disabled={smartPanels.length <= 1}
                    >
                      <IconX size={14} />
                    </ActionIcon>
                  </div>
                ))}
              </Stack>
            </ScrollArea.Autosize>

            <Button
              variant="subtle"
              color="yellow"
              size="xs"
              leftSection={<IconPlus size={14} />}
              onClick={() => setSmartPanels([...smartPanels, { prompt: '' }])}
            >
              Add Panel
            </Button>

            <Switch
              label="Enhance prompts"
              description="Use AI to add detail and composition to each panel"
              checked={smartEnhance}
              onChange={(e) => setSmartEnhance(e.currentTarget.checked)}
              color="yellow"
            />

            <Text size="sm" c="dimmed">
              Cost: {smartPanels.filter((p) => p.prompt.trim()).length} panels x{' '}
              {panelCost > 0 ? panelCost : '...'} ={' '}
              {panelCost > 0
                ? smartPanels.filter((p) => p.prompt.trim()).length * panelCost
                : 'Estimating...'}{' '}
              Buzz
            </Text>

            <Group justify="space-between">
              <Button
                variant="default"
                leftSection={<IconArrowLeft size={14} />}
                onClick={() => setSmartStep('input')}
              >
                Back
              </Button>
              <button
                className={styles.gradientBtn}
                onClick={handleSmartCreate}
                disabled={
                  smartPanels.filter((p) => p.prompt.trim()).length === 0 ||
                  smartCreateMutation.isPending
                }
              >
                {smartCreateMutation.isPending ? <Loader size={14} color="dark" /> : null}
                {smartCreateMutation.isPending ? 'Creating...' : 'Create Chapter'}
              </button>
            </Group>

            {smartCreateMutation.isError && (
              <Text size="sm" c="red">
                {smartCreateMutation.error?.message ?? 'Failed to create chapter'}
              </Text>
            )}
          </Stack>
        )}
      </Modal>

      {/* ── Settings Modal ───────────────────────── */}
      <Modal opened={settingsOpened} onClose={closeSettings} title="Project Settings" size="md">
        <Stack gap="md">
          <TextInput
            label="Project name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <Textarea
            label="Description"
            placeholder="A brief description of your comic project..."
            maxLength={5000}
            rows={3}
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
          />
          <Select
            label="Genre"
            placeholder="Select a genre"
            data={genreOptions}
            value={editGenre}
            onChange={setEditGenre}
            clearable
          />

          <div>
            <Text size="sm" fw={500} mb={4}>
              Cover Image
            </Text>
            <Text size="xs" c="dimmed" mb={8}>
              Portrait image shown in cards and chapter lists (3:4 ratio recommended)
            </Text>
            {editCoverUrl ? (
              <div className="relative inline-block">
                <div
                  className="rounded-lg overflow-hidden"
                  style={{ width: 120, height: 160, background: '#2C2E33' }}
                >
                  <img
                    src={getEdgeUrl(editCoverUrl, { width: 240 })}
                    alt="Cover"
                    className="w-full h-full object-cover"
                  />
                </div>
                <ActionIcon
                  variant="filled"
                  color="dark"
                  size="xs"
                  className="absolute -top-2 -right-2"
                  onClick={() => {
                    setEditCoverUrl(null);
                    setEditCoverImageId(null);
                  }}
                >
                  <IconX size={12} />
                </ActionIcon>
              </div>
            ) : (
              <Dropzone onDrop={handleCoverDrop} accept={IMAGE_MIME_TYPE} maxFiles={1}>
                <Group justify="center" gap="xl" mih={80} style={{ pointerEvents: 'none' }}>
                  <Dropzone.Accept>
                    <IconUpload size={24} className="text-blue-500" />
                  </Dropzone.Accept>
                  <Dropzone.Reject>
                    <IconX size={24} className="text-red-500" />
                  </Dropzone.Reject>
                  <Dropzone.Idle>
                    <IconPhoto size={24} style={{ color: '#909296' }} />
                  </Dropzone.Idle>
                  <Text size="sm" c="dimmed">
                    Drop a cover image or click to browse
                  </Text>
                </Group>
              </Dropzone>
            )}
            {coverUploadFiles.some((f) => f.status === 'uploading') && (
              <Text size="xs" c="dimmed" mt={4}>
                Uploading...
              </Text>
            )}
          </div>

          <div>
            <Text size="sm" fw={500} mb={4}>
              Hero Image
            </Text>
            <Text size="xs" c="dimmed" mb={8}>
              Wide banner shown on the comic overview page (16:9 or wider recommended)
            </Text>
            {editHeroUrl ? (
              <HeroPositionPicker
                url={editHeroUrl}
                position={editHeroPosition}
                onPositionChange={setEditHeroPosition}
                onRemove={() => {
                  setEditHeroUrl(null);
                  setEditHeroImageId(null);
                  setEditHeroPosition(50);
                }}
              />
            ) : (
              <Dropzone onDrop={handleHeroDrop} accept={IMAGE_MIME_TYPE} maxFiles={1}>
                <Group justify="center" gap="xl" mih={80} style={{ pointerEvents: 'none' }}>
                  <Dropzone.Accept>
                    <IconUpload size={24} className="text-blue-500" />
                  </Dropzone.Accept>
                  <Dropzone.Reject>
                    <IconX size={24} className="text-red-500" />
                  </Dropzone.Reject>
                  <Dropzone.Idle>
                    <IconPhoto size={24} style={{ color: '#909296' }} />
                  </Dropzone.Idle>
                  <Text size="sm" c="dimmed">
                    Drop a hero banner or click to browse
                  </Text>
                </Group>
              </Dropzone>
            )}
            {heroUploadFiles.some((f) => f.status === 'uploading') && (
              <Text size="xs" c="dimmed" mt={4}>
                Uploading...
              </Text>
            )}
          </div>

          <Group justify="flex-end">
            <Button variant="default" onClick={closeSettings}>
              Cancel
            </Button>
            <button
              className={styles.gradientBtn}
              onClick={handleSaveSettings}
              disabled={!editName.trim()}
            >
              Save
            </button>
          </Group>
        </Stack>
      </Modal>

      {/* ── Debug Modal ──────────────────────────── */}
      <PanelDebugModal panelId={debugPanelId} opened={debugModalOpened} onClose={closeDebugModal} />
    </>
  );
}

export default Page(ProjectWorkspace);
