import {
  ActionIcon,
  Button,
  Code,
  Container,
  Group,
  Loader,
  Menu,
  Modal,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
  Badge,
} from '@mantine/core';
import { Dropzone, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBook,
  IconBug,
  IconDotsVertical,
  IconPencil,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconRefreshDot,
  IconSettings,
  IconSparkles,
  IconTrash,
  IconUpload,
  IconUser,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import styles from './ProjectWorkspace.module.scss';

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
  const projectId = id as string;

  const [panelModalOpened, { open: openPanelModal, close: closePanelModal }] = useDisclosure(false);
  const [debugModalOpened, { open: openDebugModal, close: closeDebugModal }] = useDisclosure(false);
  const [settingsOpened, { open: openSettings, close: closeSettings }] = useDisclosure(false);
  const [debugPanelId, setDebugPanelId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<Set<string>>(new Set());
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [regeneratingPanelId, setRegeneratingPanelId] = useState<string | null>(null);

  // Chapter rename state
  const [editingChapterId, setEditingChapterId] = useState<string | null>(null);
  const [editChapterName, setEditChapterName] = useState('');
  const chapterInputRef = useRef<HTMLInputElement>(null);

  // Settings modal state
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editCoverUrl, setEditCoverUrl] = useState<string | null>(null);
  const { uploadToCF, files: coverUploadFiles, resetFiles: resetCoverFiles } = useCFImageUpload();

  // Panel detail drawer state
  const [detailPanelId, setDetailPanelId] = useState<string | null>(null);
  // Insert-at-position state for adding panels between existing ones
  const [insertAtPosition, setInsertAtPosition] = useState<number | null>(null);

  // Smart Create modal state
  const [smartModalOpened, { open: openSmartModal, close: closeSmartModal }] = useDisclosure(false);
  const [smartStep, setSmartStep] = useState<'input' | 'review'>('input');
  const [smartChapterName, setSmartChapterName] = useState('New Chapter');
  const [smartStory, setSmartStory] = useState('');
  const [smartCharacterIds, setSmartCharacterIds] = useState<Set<string>>(new Set());
  const [smartPanels, setSmartPanels] = useState<{ prompt: string }[]>([]);
  const [smartEnhance, setSmartEnhance] = useState(true);

  const panelSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const {
    data: project,
    isLoading,
    refetch,
  } = trpc.comics.getProject.useQuery({ id: projectId }, { enabled: !!projectId });

  // Dynamic cost estimate from orchestrator
  const { data: costEstimate } = trpc.comics.getPanelCostEstimate.useQuery(undefined, {
    staleTime: 5 * 60 * 1000, // cache for 5 minutes
  });
  const panelCost = costEstimate?.cost ?? 25; // fallback to 25 if unavailable

  // Set active chapter to first chapter on load
  useEffect(() => {
    if (project?.chapters?.length && !activeChapterId) {
      setActiveChapterId(project.chapters[0].id);
    }
  }, [project?.chapters, activeChapterId]);

  // Combine project characters and library characters
  const allCharacters = useMemo(
    () => [...(project?.references ?? []), ...(project?.libraryReferences ?? [])],
    [project?.references, project?.libraryReferences]
  );

  // Build character image map from reference images
  const characterImageMap = useMemo(() => {
    const map = new Map<string, { url: string }>();
    for (const c of allCharacters) {
      const firstImage = (c as any).images?.[0]?.image;
      if (firstImage?.url) {
        map.set(c.id, { url: firstImage.url });
      }
    }
    return map;
  }, [allCharacters]);

  const createPanelMutation = trpc.comics.createPanel.useMutation({
    onSuccess: () => {
      closePanelModal();
      setPrompt('');
      setRegeneratingPanelId(null);
      setInsertAtPosition(null);
      refetch();
    },
  });

  const deletePanelMutation = trpc.comics.deletePanel.useMutation({
    onSuccess: () => {
      refetch();
      setDetailPanelId(null);
    },
  });

  const reorderPanelsMutation = trpc.comics.reorderPanels.useMutation({
    onSuccess: () => refetch(),
  });

  const createChapterMutation = trpc.comics.createChapter.useMutation({
    onSuccess: (data) => {
      setActiveChapterId(data.id);
      refetch();
    },
  });

  const updateChapterMutation = trpc.comics.updateChapter.useMutation({
    onSuccess: () => refetch(),
  });

  const deleteChapterMutation = trpc.comics.deleteChapter.useMutation({
    onSuccess: () => refetch(),
  });

  const updateProjectMutation = trpc.comics.updateProject.useMutation({
    onSuccess: () => {
      closeSettings();
      refetch();
    },
  });

  const deleteCharacterMutation = trpc.comics.deleteReference.useMutation({
    onSuccess: () => refetch(),
  });

  const planPanelsMutation = trpc.comics.planChapterPanels.useMutation({
    onSuccess: (data) => {
      setSmartPanels(data.panels);
      setSmartStep('review');
    },
  });

  const smartCreateMutation = trpc.comics.smartCreateChapter.useMutation({
    onSuccess: (data) => {
      closeSmartModal();
      setActiveChapterId(data.id);
      resetSmartState();
      refetch();
    },
  });

  const utils = trpc.useUtils();

  // Get active chapter's panels
  const activeChapter = useMemo(
    () => project?.chapters?.find((ch) => ch.id === activeChapterId) ?? project?.chapters?.[0],
    [project?.chapters, activeChapterId]
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
  }, [generatingPanelIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for characters in Pending state (waiting for images)
  const processingCharacterIds = useMemo(
    () => allCharacters.filter((c) => c.status === 'Pending').map((c) => c.id),
    [allCharacters]
  );

  useEffect(() => {
    if (processingCharacterIds.length === 0) return;
    const interval = setInterval(async () => {
      try {
        const results = await Promise.all(
          processingCharacterIds.map((cid) =>
            utils.comics.pollReferenceStatus.fetch({ referenceId: cid })
          )
        );
        if (results.some((r) => r.status === 'Ready' || r.status === 'Failed')) refetch();
      } catch {
        /* ignore */
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [processingCharacterIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus chapter rename input
  useEffect(() => {
    if (editingChapterId && chapterInputRef.current) {
      chapterInputRef.current.focus();
      chapterInputRef.current.select();
    }
  }, [editingChapterId]);

  // Build character name map for panel cards
  const characterNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of allCharacters) {
      map.set(c.id, c.name);
    }
    return map;
  }, [allCharacters]);

  const activeCharacters = useMemo(
    () => allCharacters.filter((c) => c.status === 'Ready'),
    [allCharacters]
  );

  // Auto-select all ready references if none explicitly selected
  const effectiveSelectedIds = useMemo(() => {
    if (selectedReferenceIds.size > 0) return selectedReferenceIds;
    return new Set(activeCharacters.map((c) => c.id));
  }, [selectedReferenceIds, activeCharacters]);

  const selectedRefsHaveImages = useMemo(
    () =>
      activeCharacters
        .filter((c) => effectiveSelectedIds.has(c.id))
        .some((c) => ((c as any).images?.length ?? 0) > 0),
    [activeCharacters, effectiveSelectedIds]
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
      chapterId: activeChapter.id,
      panelIds: reordered.map((p) => p.id),
    });
  };

  const handleGeneratePanel = async () => {
    const refIds = Array.from(effectiveSelectedIds);
    if (!prompt.trim() || refIds.length === 0 || !activeChapter || !selectedRefsHaveImages) return;
    if (regeneratingPanelId) {
      await deletePanelMutation.mutateAsync({ panelId: regeneratingPanelId });
    }
    createPanelMutation.mutate({
      chapterId: activeChapter.id,
      referenceIds: refIds,
      prompt: prompt.trim(),
      enhance: enhancePrompt,
      ...(insertAtPosition != null ? { position: insertAtPosition } : {}),
    });
  };

  const handleSaveChapterName = () => {
    if (!editingChapterId || !editChapterName.trim()) {
      setEditingChapterId(null);
      return;
    }
    updateChapterMutation.mutate(
      { chapterId: editingChapterId, name: editChapterName.trim() },
      { onSettled: () => setEditingChapterId(null) }
    );
  };

  const handleDeleteChapter = (chapterId: string, chapterName: string) => {
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
        deleteChapterMutation.mutate({ chapterId });
        if (activeChapterId === chapterId) {
          const remaining = project.chapters.filter((ch) => ch.id !== chapterId);
          setActiveChapterId(remaining[0]?.id ?? null);
        }
      },
    });
  };

  const handleDeleteCharacter = (characterId: string, characterName: string) => {
    openConfirmModal({
      title: 'Delete Character',
      children: (
        <Text size="sm">
          Are you sure you want to delete &quot;{characterName}&quot;? Existing panels will be
          preserved but unlinked.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        deleteCharacterMutation.mutate({ referenceId: characterId });
        setSelectedReferenceIds((prev) => {
          const next = new Set(prev);
          next.delete(characterId);
          return next;
        });
      },
    });
  };

  const handleOpenSettings = () => {
    setEditName(project.name);
    setEditDescription(project.description ?? '');
    setEditCoverUrl(project.coverImageUrl ?? null);
    resetCoverFiles();
    openSettings();
  };

  const handleSaveSettings = () => {
    updateProjectMutation.mutate({
      id: projectId,
      name: editName.trim() || undefined,
      description: editDescription.trim() || null,
      coverImageUrl: editCoverUrl,
    });
  };

  const handleCoverDrop = async (files: File[]) => {
    if (files.length === 0) return;
    const result = await uploadToCF(files[0]);
    setEditCoverUrl(result.id);
  };

  const resetSmartState = () => {
    setSmartStep('input');
    setSmartChapterName('New Chapter');
    setSmartStory('');
    setSmartCharacterIds(new Set());
    setSmartPanels([]);
    setSmartEnhance(true);
  };

  const handlePlanPanels = () => {
    if (!smartStory.trim()) return;
    planPanelsMutation.mutate({ projectId, storyDescription: smartStory.trim() });
  };

  const handleSmartCreate = () => {
    const smartRefIds =
      smartCharacterIds.size > 0
        ? Array.from(smartCharacterIds)
        : activeCharacters.map((c) => c.id);
    if (smartRefIds.length === 0 || smartPanels.length === 0) return;
    smartCreateMutation.mutate({
      projectId,
      chapterName: smartChapterName.trim() || 'New Chapter',
      referenceIds: smartRefIds,
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
              {project.coverImageUrl ? (
                <img src={getEdgeUrl(project.coverImageUrl, { width: 160 })} alt={project.name} />
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
                onClick={() => router.push(`/comics/project/${projectId}/read`)}
                disabled={!hasReadyPanelsWithImages}
              >
                <IconBook size={16} />
                Read
              </button>
            </div>
          </div>

          {/* ── Main layout ─────────────────────────── */}
          <div className={styles.workspaceGrid}>
            {/* ── Sidebar: Characters ─────────────── */}
            <div className={styles.sidebarSection}>
              <div className={styles.sidebarTitle}>
                <span>Characters</span>
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
                {allCharacters.length === 0 ? (
                  <div className="flex flex-col items-center py-8 text-center">
                    <IconUser size={32} style={{ color: '#605e6e', marginBottom: 12 }} />
                    <Text size="sm" c="dimmed" mb="md">
                      No characters yet
                    </Text>
                    <button
                      className={styles.gradientBtn}
                      onClick={() => router.push(`/comics/project/${projectId}/character`)}
                    >
                      <IconPlus size={14} />
                      Add Character
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Project characters */}
                    {(project.references ?? []).length > 0 && (
                      <>
                        <Text size="xs" c="dimmed" fw={600} mt={4} mb={-4} px={4}>
                          Project
                        </Text>
                        {project.references.map((character) => (
                          <CharacterSidebarItem
                            key={character.id}
                            character={character}
                            projectId={projectId}
                            isSelected={effectiveSelectedIds.has(character.id)}
                            characterImageMap={characterImageMap}
                            onToggle={(id) =>
                              setSelectedReferenceIds((prev) => {
                                // If nothing was explicitly selected, start from the auto-set
                                const base =
                                  prev.size === 0
                                    ? new Set(activeCharacters.map((c) => c.id))
                                    : new Set(prev);
                                if (base.has(id)) base.delete(id);
                                else base.add(id);
                                return base;
                              })
                            }
                            onDelete={handleDeleteCharacter}
                            getStatusDotClass={getStatusDotClass}
                            getStatusLabel={getStatusLabel}
                          />
                        ))}
                      </>
                    )}

                    {/* Library characters */}
                    {(project.libraryReferences ?? []).length > 0 && (
                      <>
                        <Text size="xs" c="dimmed" fw={600} mt={8} mb={-4} px={4}>
                          My Library
                        </Text>
                        {project.libraryReferences!.map((character) => (
                          <CharacterSidebarItem
                            key={character.id}
                            character={character}
                            projectId={projectId}
                            isSelected={effectiveSelectedIds.has(character.id)}
                            characterImageMap={characterImageMap}
                            onToggle={(id) =>
                              setSelectedReferenceIds((prev) => {
                                const base =
                                  prev.size === 0
                                    ? new Set(activeCharacters.map((c) => c.id))
                                    : new Set(prev);
                                if (base.has(id)) base.delete(id);
                                else base.add(id);
                                return base;
                              })
                            }
                            onDelete={handleDeleteCharacter}
                            getStatusDotClass={getStatusDotClass}
                            getStatusLabel={getStatusLabel}
                          />
                        ))}
                      </>
                    )}
                  </>
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
                  const isActive = (activeChapterId ?? project.chapters[0]?.id) === chapter.id;
                  const panelCount = chapter.panels.length;

                  return (
                    <div
                      key={chapter.id}
                      className={clsx(styles.chapterItem, isActive && styles.chapterItemActive)}
                      onClick={() => {
                        if (editingChapterId !== chapter.id) setActiveChapterId(chapter.id);
                      }}
                    >
                      <span className={styles.chapterItemNumber}>{idx + 1}</span>
                      <div className={styles.chapterItemInfo}>
                        {editingChapterId === chapter.id ? (
                          <input
                            ref={chapterInputRef}
                            className={styles.chapterItemInput}
                            value={editChapterName}
                            onChange={(e) => setEditChapterName(e.target.value)}
                            onBlur={handleSaveChapterName}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveChapterName();
                              if (e.key === 'Escape') setEditingChapterId(null);
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
                            setEditingChapterId(chapter.id);
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
                              handleDeleteChapter(chapter.id, chapter.name);
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

                {activeCharacters.length > 0 && (
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
              {activeCharacters.length === 0 && allCharacters.length === 0 && (
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

              {activeCharacters.length === 0 && allCharacters.length > 0 && (
                <div className="py-8 text-center">
                  <Text c="dimmed" size="sm">
                    Wait for your references to finish processing before generating panels.
                  </Text>
                </div>
              )}

              {activeCharacters.length > 0 && !selectedRefsHaveImages && (
                <div
                  className="flex items-center justify-between py-4 px-4 rounded-lg"
                  style={{ background: '#2C2E33', border: '1px solid #373A40' }}
                >
                  <Text c="dimmed" size="sm">
                    Selected references need images before generating panels.
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
                activeCharacters.length > 0 &&
                selectedRefsHaveImages && (
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
                              .map((r: { referenceId: string }) =>
                                characterNameMap.get(r.referenceId)
                              )
                              .filter(Boolean) as string[]
                          }
                          onDelete={() => deletePanelMutation.mutate({ panelId: panel.id })}
                          onViewDebug={() => {
                            setDebugPanelId(panel.id);
                            openDebugModal();
                          }}
                          onRegenerate={() => {
                            setRegeneratingPanelId(panel.id);
                            setPrompt(panel.prompt);
                            const panelRefIds = (panel.references ?? []).map(
                              (r: { referenceId: string }) => r.referenceId
                            );
                            if (panelRefIds.length > 0) {
                              setSelectedReferenceIds(new Set(panelRefIds));
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
                    {activeCharacters.length > 0 && selectedRefsHaveImages && (
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

              {/* Status + Character row */}
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
                {(detailPanel.references ?? []).map((r: { referenceId: string }) => {
                  const name = characterNameMap.get(r.referenceId);
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

              {/* Actions */}
              <div className={styles.detailActions}>
                {(detailPanel.status === 'Ready' || detailPanel.status === 'Failed') && (
                  <button
                    className={styles.gradientBtn}
                    onClick={() => {
                      setDetailPanelId(null);
                      setRegeneratingPanelId(detailPanel.id);
                      setPrompt(detailPanel.prompt);
                      const panelRefIds = (detailPanel.references ?? []).map(
                        (r: { referenceId: string }) => r.referenceId
                      );
                      if (panelRefIds.length > 0) {
                        setSelectedReferenceIds(new Set(panelRefIds));
                      }
                      openPanelModal();
                    }}
                  >
                    <IconRefreshDot size={16} />
                    Regenerate
                  </button>
                )}
                {detailPanelIndex >= 0 && activeCharacters.length > 0 && selectedRefsHaveImages && (
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

      {/* ── Generate Panel Modal ─────────────────── */}
      <Modal
        opened={panelModalOpened}
        onClose={() => {
          closePanelModal();
          setRegeneratingPanelId(null);
          setInsertAtPosition(null);
        }}
        title={
          regeneratingPanelId
            ? 'Regenerate Panel'
            : insertAtPosition != null
            ? 'Insert Panel'
            : 'Generate Panel'
        }
        size="lg"
      >
        <Stack gap="md">
          <div>
            <Text size="sm" fw={500} mb={4}>
              References ({effectiveSelectedIds.size} selected)
            </Text>
            <Group gap="xs">
              {activeCharacters.map((c) => (
                <button
                  key={c.id}
                  className={clsx(
                    styles.detailCharacterPill,
                    effectiveSelectedIds.has(c.id) && styles.characterPillSelected
                  )}
                  style={{
                    padding: '3px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    opacity: effectiveSelectedIds.has(c.id) ? 1 : 0.5,
                  }}
                  onClick={() =>
                    setSelectedReferenceIds((prev) => {
                      const base =
                        prev.size === 0
                          ? new Set(activeCharacters.map((r) => r.id))
                          : new Set(prev);
                      if (base.has(c.id)) base.delete(c.id);
                      else base.add(c.id);
                      return base;
                    })
                  }
                >
                  <IconUser size={12} />
                  {c.name}
                </button>
              ))}
            </Group>
          </div>

          <Textarea
            label="Describe the scene"
            placeholder="Maya standing on a rooftop at sunset, wind blowing her hair, looking determined"
            rows={4}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />

          <Switch
            label="Enhance prompt"
            description="Use AI to add detail and composition to your prompt"
            checked={enhancePrompt}
            onChange={(e) => setEnhancePrompt(e.currentTarget.checked)}
            color="yellow"
          />

          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              Cost: {panelCost > 0 ? `${panelCost} Buzz` : 'Estimating...'}
            </Text>
            <Group>
              <Button
                variant="default"
                onClick={() => {
                  closePanelModal();
                  setRegeneratingPanelId(null);
                }}
              >
                Cancel
              </Button>
              <button
                className={styles.gradientBtn}
                onClick={handleGeneratePanel}
                disabled={
                  !prompt.trim() || deletePanelMutation.isPending || createPanelMutation.isPending
                }
              >
                {insertAtPosition != null ? 'Insert' : 'Generate'}
              </button>
            </Group>
          </Group>
        </Stack>
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

            <div>
              <Text size="sm" fw={500} mb={4}>
                References
              </Text>
              <Group gap="xs">
                {activeCharacters.map((c) => {
                  const effectiveSmartIds =
                    smartCharacterIds.size > 0
                      ? smartCharacterIds
                      : new Set(activeCharacters.map((r) => r.id));
                  return (
                    <button
                      key={c.id}
                      className={clsx(
                        styles.detailCharacterPill,
                        effectiveSmartIds.has(c.id) && styles.characterPillSelected
                      )}
                      style={{
                        padding: '3px 10px',
                        fontSize: 12,
                        cursor: 'pointer',
                        opacity: effectiveSmartIds.has(c.id) ? 1 : 0.5,
                      }}
                      onClick={() =>
                        setSmartCharacterIds((prev) => {
                          const base =
                            prev.size === 0
                              ? new Set(activeCharacters.map((r) => r.id))
                              : new Set(prev);
                          if (base.has(c.id)) base.delete(c.id);
                          else base.add(c.id);
                          return base;
                        })
                      }
                    >
                      <IconUser size={12} />
                      {c.name}
                    </button>
                  );
                })}
              </Group>
            </div>

            <Textarea
              label="Describe the story or scene"
              placeholder="A warrior discovers an ancient temple in the jungle, encounters a guardian spirit, and must prove their worth through a test of courage..."
              rows={6}
              autosize
              minRows={4}
              maxRows={10}
              value={smartStory}
              onChange={(e) => setSmartStory(e.target.value)}
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
                    <Textarea
                      className="flex-1"
                      autosize
                      minRows={2}
                      maxRows={5}
                      value={panel.prompt}
                      onChange={(e) => {
                        const updated = [...smartPanels];
                        updated[index] = { prompt: e.target.value };
                        setSmartPanels(updated);
                      }}
                    />
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

          <div>
            <Text size="sm" fw={500} mb={4}>
              Cover Image
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
                  onClick={() => setEditCoverUrl(null)}
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

// ── Character sidebar item ─────────────────────────
function CharacterSidebarItem({
  character,
  projectId,
  isSelected,
  characterImageMap,
  onToggle,
  onDelete,
  getStatusDotClass,
  getStatusLabel,
}: {
  character: { id: string; name: string; status: string; images?: any[] };
  projectId: string;
  isSelected: boolean;
  characterImageMap: Map<string, { url: string }>;
  onToggle: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  getStatusDotClass: (status: string, hasRefs: boolean) => string;
  getStatusLabel: (status: string, hasRefs: boolean, isFailed: boolean) => string;
}) {
  const coverImage = characterImageMap.get(character.id);
  const charHasRefs = (character.images?.length ?? 0) > 0;
  const isFailed = character.status === 'Failed';
  const isReady = character.status === 'Ready';

  return (
    <div
      className={clsx(styles.characterCard, isSelected && isReady && styles.characterCardSelected)}
      onClick={() => {
        if (isReady) onToggle(character.id);
      }}
    >
      <Link
        href={`/comics/project/${projectId}/character?characterId=${character.id}`}
        className={styles.characterAvatar}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        {isFailed ? (
          <IconAlertTriangle size={18} style={{ color: '#fa5252' }} />
        ) : coverImage ? (
          <EdgeMedia2
            src={coverImage.url}
            type="image"
            name={character.name}
            alt={character.name}
            width={80}
            style={{
              maxWidth: '100%',
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: 'top center',
              display: 'block',
            }}
          />
        ) : (
          <IconUser size={18} style={{ color: '#909296' }} />
        )}
      </Link>

      <div className={styles.characterInfo}>
        <Link
          href={`/comics/project/${projectId}/character?characterId=${character.id}`}
          className={styles.characterName}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
        >
          {character.name}
        </Link>
        <p className={styles.characterStatus}>
          <span
            className={clsx(styles.statusDot, getStatusDotClass(character.status, charHasRefs))}
          />
          {getStatusLabel(character.status, charHasRefs, isFailed)}
        </p>
      </div>

      <div className={styles.characterDelete}>
        <ActionIcon
          variant="subtle"
          color="red"
          size="sm"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            onDelete(character.id, character.name);
          }}
        >
          <IconTrash size={14} />
        </ActionIcon>
      </div>
    </div>
  );
}

// ── Sortable panel wrapper ─────────────────────────
function SortablePanel({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        cursor: isDragging ? 'grabbing' : 'grab',
        opacity: isDragging ? 0.5 : 1,
        touchAction: 'none',
      }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

// ── Panel card ─────────────────────────────────────
interface PanelCardProps {
  panel: {
    id: string;
    imageUrl: string | null;
    prompt: string;
    status: string;
    errorMessage: string | null;
  };
  position: number;
  referenceNames: string[];
  onDelete: () => void;
  onViewDebug: () => void;
  onRegenerate: () => void;
  onInsertAfter: () => void;
  onClick: () => void;
}

function PanelCard({
  panel,
  position,
  referenceNames,
  onDelete,
  onViewDebug,
  onRegenerate,
  onInsertAfter,
  onClick,
}: PanelCardProps) {
  const { imageUrl, prompt, status, errorMessage } = panel;

  return (
    <div className={styles.panelCard} onClick={onClick}>
      {imageUrl ? (
        <>
          <img
            src={getEdgeUrl(imageUrl, { width: 450 })}
            alt={prompt}
            className={styles.panelImage}
          />
          <div className={styles.panelOverlay}>
            <div className="flex justify-between items-start">
              <span className={styles.panelNumber}>#{position}</span>
              <div className={styles.panelMenu}>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon
                      variant="filled"
                      color="dark"
                      size="sm"
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    >
                      <IconDotsVertical size={14} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {(status === 'Ready' || status === 'Failed') && (
                      <Menu.Item
                        leftSection={<IconRefreshDot size={14} />}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          onRegenerate();
                        }}
                      >
                        Regenerate
                      </Menu.Item>
                    )}
                    <Menu.Item
                      leftSection={<IconPlus size={14} />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onInsertAfter();
                      }}
                    >
                      Insert after
                    </Menu.Item>
                    <Menu.Item
                      leftSection={<IconBug size={14} />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onViewDebug();
                      }}
                    >
                      Debug Info
                    </Menu.Item>
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        onDelete();
                      }}
                    >
                      Delete
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              {referenceNames.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {referenceNames.map((name) => (
                    <span key={name} className={styles.panelCharacterPill}>
                      <IconUser size={10} />
                      {name}
                    </span>
                  ))}
                </div>
              )}
              <p className={styles.panelPrompt}>{prompt}</p>
            </div>
          </div>
        </>
      ) : (
        <>
          {status === 'Generating' || status === 'Pending' ? (
            <div className={styles.panelEmpty}>
              <div className={styles.spinner} />
              <Text size="xs">{status === 'Pending' ? 'Queued' : 'Generating...'}</Text>
            </div>
          ) : status === 'Failed' ? (
            <div className={styles.panelFailed}>
              <IconAlertTriangle size={28} />
              <Text size="xs" c="red">
                Failed
              </Text>
              {errorMessage && (
                <Text size="xs" c="dimmed" ta="center" lineClamp={2} px="xs">
                  {errorMessage}
                </Text>
              )}
            </div>
          ) : (
            <div className={styles.panelEmpty}>
              <IconPhoto size={28} />
            </div>
          )}
          <div className="absolute top-2 left-2">
            <span className={styles.panelNumber}>#{position}</span>
          </div>
        </>
      )}
    </div>
  );
}

// ── Debug modal ────────────────────────────────────
function PanelDebugModal({
  panelId,
  opened,
  onClose,
}: {
  panelId: string | null;
  opened: boolean;
  onClose: () => void;
}) {
  const { data, isLoading } = trpc.comics.getPanelDebugInfo.useQuery(
    { panelId: panelId! },
    { enabled: opened && !!panelId }
  );

  const meta = data?.panel.metadata as Record<string, any> | null | undefined;

  return (
    <Modal opened={opened} onClose={onClose} title="Panel Debug Info" size="lg">
      <ScrollArea.Autosize mah="70vh">
        {isLoading ? (
          <Stack align="center" py="xl">
            <Loader />
          </Stack>
        ) : data ? (
          <Stack gap="md">
            {data.panel.errorMessage && (
              <div>
                <Text fw={600} size="sm" mb={4} c="red">
                  Error
                </Text>
                <Code block color="red">
                  {data.panel.errorMessage}
                </Code>
              </div>
            )}
            <div>
              <Group gap="xs" mb={4}>
                <Text fw={600} size="sm">
                  Prompts
                </Text>
                <Badge size="xs" variant="light" color={meta?.enhanceEnabled ? 'teal' : 'gray'}>
                  Enhance {meta?.enhanceEnabled ? 'ON' : 'OFF'}
                </Badge>
              </Group>
              <Stack gap="xs">
                <div>
                  <Text size="xs" c="dimmed" mb={2}>
                    Original
                  </Text>
                  <Code block>{data.panel.prompt}</Code>
                </div>
                {data.panel.enhancedPrompt && (
                  <div>
                    <Text size="xs" c="dimmed" mb={2}>
                      Enhanced
                    </Text>
                    <Code block>{data.panel.enhancedPrompt}</Code>
                  </div>
                )}
              </Stack>
            </div>
            {meta?.previousPanelId && (
              <div>
                <Text fw={600} size="sm" mb={4}>
                  Previous Panel Context
                </Text>
                <Stack gap="xs">
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      ID:
                    </Text>
                    <Code>{meta.previousPanelId}</Code>
                  </Group>
                  {meta.previousPanelPrompt && (
                    <div>
                      <Text size="xs" c="dimmed" mb={2}>
                        Prompt used
                      </Text>
                      <Code block>{meta.previousPanelPrompt}</Code>
                    </div>
                  )}
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">
                      Had image:
                    </Text>
                    <Badge
                      size="xs"
                      variant="light"
                      color={meta.previousPanelImageUrl ? 'green' : 'gray'}
                    >
                      {meta.previousPanelImageUrl ? 'Yes' : 'No'}
                    </Badge>
                  </Group>
                </Stack>
              </div>
            )}
            {meta?.referenceImages?.length > 0 && (
              <div>
                <Text fw={600} size="sm" mb={4}>
                  Reference Images ({meta!.referenceImages.length})
                </Text>
                <Stack gap="xs">
                  {(meta!.referenceImages as { url: string; width: number; height: number }[]).map(
                    (img, i) => (
                      <Group key={i} gap="xs">
                        <Badge size="xs" variant="light">
                          {img.width}x{img.height}
                        </Badge>
                        <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }} lineClamp={1}>
                          {img.url}
                        </Text>
                      </Group>
                    )
                  )}
                </Stack>
              </div>
            )}
            <div>
              <Text fw={600} size="sm" mb={4}>
                References ({data.references?.length ?? 0})
              </Text>
              {data.references && data.references.length > 0 ? (
                <Stack gap="xs">
                  {data.references.map((ref: any) => (
                    <Group key={ref.id} gap="xs">
                      <Text size="xs">{ref.name}</Text>
                      <Badge size="xs" variant="light">
                        {ref.images?.length ?? 0} images
                      </Badge>
                    </Group>
                  ))}
                  {meta?.allCharacterNames && (
                    <Group gap="xs">
                      <Text size="xs" c="dimmed">
                        All known:
                      </Text>
                      <Text size="xs">{(meta.allCharacterNames as string[]).join(', ')}</Text>
                    </Group>
                  )}
                </Stack>
              ) : (
                <Text size="xs" c="dimmed">
                  No reference info
                </Text>
              )}
            </div>
            <div>
              <Text fw={600} size="sm" mb={4}>
                Generation Parameters
              </Text>
              <Code block>
                {JSON.stringify(meta?.generationParams ?? data.generation, null, 2)}
              </Code>
            </div>
            <div>
              <Text fw={600} size="sm" mb={4}>
                Panel Record
              </Text>
              <Code block>
                {JSON.stringify(
                  {
                    id: data.panel.id,
                    status: data.panel.status,
                    workflowId: data.panel.workflowId,
                    createdAt: data.panel.createdAt,
                    updatedAt: data.panel.updatedAt,
                  },
                  null,
                  2
                )}
              </Code>
            </div>
            {data.workflow && (
              <div>
                <Text fw={600} size="sm" mb={4}>
                  Orchestrator Workflow
                </Text>
                <Code block>{JSON.stringify(data.workflow, null, 2)}</Code>
              </div>
            )}
          </Stack>
        ) : (
          <Text c="dimmed">No debug info available</Text>
        )}
      </ScrollArea.Autosize>
    </Modal>
  );
}

export default Page(ProjectWorkspace);
