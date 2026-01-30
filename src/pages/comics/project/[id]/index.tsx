import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Code,
  Container,
  Grid,
  Group,
  Image,
  Loader,
  Menu,
  Modal,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconBook,
  IconBug,
  IconDotsVertical,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconRefreshDot,
  IconTrash,
  IconUser,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';

import type { DragEndEvent } from '@dnd-kit/core';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

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
  const [debugPanelId, setDebugPanelId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [regeneratingPanelId, setRegeneratingPanelId] = useState<string | null>(null);

  const panelSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const { data: project, isLoading, refetch } = trpc.comics.getProject.useQuery(
    { id: projectId },
    { enabled: !!projectId }
  );

  // Set active chapter to first chapter on load
  useEffect(() => {
    if (project?.chapters?.length && !activeChapterId) {
      setActiveChapterId(project.chapters[0].id);
    }
  }, [project?.chapters, activeChapterId]);

  // Fetch cover images for characters that have a linked model
  const characterModelEntities = useMemo(
    () =>
      (project?.characters ?? [])
        .filter((c) => c.modelId)
        .map((c) => ({ entityType: 'Model' as const, entityId: c.modelId! })),
    [project?.characters]
  );
  const { data: characterCoverImages } = trpc.image.getEntitiesCoverImage.useQuery(
    { entities: characterModelEntities },
    { enabled: characterModelEntities.length > 0 }
  );
  const characterImageMap = useMemo(() => {
    const map = new Map<number, { url: string; type: string; metadata?: any }>();
    if (characterCoverImages) {
      for (const img of characterCoverImages) {
        map.set(img.entityId, { url: img.url, type: img.type, metadata: img.metadata });
      }
    }
    return map;
  }, [characterCoverImages]);

  const createPanelMutation = trpc.comics.createPanel.useMutation({
    onSuccess: () => {
      closePanelModal();
      setPrompt('');
      setRegeneratingPanelId(null);
      refetch();
    },
  });

  const deletePanelMutation = trpc.comics.deletePanel.useMutation({
    onSuccess: () => refetch(),
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

  const utils = trpc.useUtils();

  // Get active chapter's panels
  const activeChapter = useMemo(
    () => project?.chapters?.find((ch) => ch.id === activeChapterId) ?? project?.chapters?.[0],
    [project?.chapters, activeChapterId]
  );

  // Poll for panels actively generating
  const generatingPanelIds = useMemo(
    () =>
      (activeChapter?.panels ?? [])
        .filter((p) => p.status === 'Generating')
        .map((p) => p.id),
    [activeChapter?.panels]
  );

  useEffect(() => {
    if (generatingPanelIds.length === 0) return;

    const interval = setInterval(async () => {
      try {
        const results = await Promise.all(
          generatingPanelIds.map((panelId) =>
            utils.comics.pollPanelStatus.fetch({ panelId })
          )
        );
        // If any panel changed status, refetch the full project
        const changed = results.some(
          (r) => r.status === 'Ready' || r.status === 'Failed'
        );
        if (changed) refetch();
      } catch {
        // Silently ignore poll errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [generatingPanelIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for characters in Pending/Processing state
  const processingCharacterIds = useMemo(
    () =>
      (project?.characters ?? [])
        .filter((c) => c.status === 'Pending' || c.status === 'Processing')
        .map((c) => c.id),
    [project?.characters]
  );

  useEffect(() => {
    if (processingCharacterIds.length === 0) return;

    const interval = setInterval(async () => {
      try {
        const results = await Promise.all(
          processingCharacterIds.map((characterId) =>
            utils.comics.pollCharacterStatus.fetch({ characterId })
          )
        );
        const changed = results.some(
          (r) => r.status === 'Ready' || r.status === 'Failed'
        );
        if (changed) refetch();
      } catch {
        // Silently ignore poll errors
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [processingCharacterIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || !project) {
    return (
      <Container size="xl" py="xl">
        <Text>Loading project...</Text>
      </Container>
    );
  }

  const activeCharacters = project.characters.filter((c) => c.status === 'Ready');
  const activeCharacter = activeCharacters.find((c) => c.id === selectedCharacterId)
    ?? activeCharacters[0]
    ?? null;

  const activeCharacterHasRefs = activeCharacter && (
    ((activeCharacter.generatedReferenceImages as any[])?.length ?? 0) > 0 ||
    ((activeCharacter.referenceImages as any[])?.length ?? 0) > 0
  );

  const hasReadyPanelsWithImages = project.chapters.some((ch) =>
    ch.panels.some((p) => p.status === 'Ready' && p.imageUrl)
  );

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
    if (!prompt.trim() || !activeCharacter || !activeChapter || !activeCharacterHasRefs) return;

    // If regenerating, delete the old panel first so it isn't used as previous-panel context
    if (regeneratingPanelId) {
      await deletePanelMutation.mutateAsync({ panelId: regeneratingPanelId });
    }

    createPanelMutation.mutate({
      chapterId: activeChapter.id,
      characterId: activeCharacter.id,
      prompt: prompt.trim(),
      enhance: enhancePrompt,
    });
  };

  return (
    <>
      <Meta title={`${project.name} - Civitai Comics`} />

      <Container size="xl" py="xl">
        <Stack gap="xl">
          {/* Header */}
          <Group justify="space-between">
            <Group>
              <ActionIcon variant="subtle" component={Link} href="/comics">
                <IconArrowLeft size={20} />
              </ActionIcon>
              <Title order={2}>{project.name}</Title>
            </Group>
            <Button
              variant="light"
              leftSection={<IconBook size={16} />}
              component={Link}
              href={`/comics/project/${projectId}/read`}
              disabled={!hasReadyPanelsWithImages}
            >
              Read
            </Button>
          </Group>

          <Grid>
            {/* Sidebar - Character */}
            <Grid.Col span={{ base: 12, md: 3 }}>
              <Stack gap="sm">
                <Group justify="space-between">
                  <Text fw={500}>Characters</Text>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    component={Link}
                    href={`/comics/project/${projectId}/character`}
                  >
                    <IconPlus size={16} />
                  </ActionIcon>
                </Group>

                {project.characters.length === 0 ? (
                  <Card withBorder>
                    <Stack align="center" gap="sm" py="md">
                      <IconUser size={32} className="text-gray-500" />
                      <Text size="sm" c="dimmed" ta="center">
                        No character yet
                      </Text>
                      <Button
                        size="sm"
                        component={Link}
                        href={`/comics/project/${projectId}/character`}
                      >
                        Add Character
                      </Button>
                    </Stack>
                  </Card>
                ) : (
                  project.characters.map((character) => {
                    const coverImage = character.modelId
                      ? characterImageMap.get(character.modelId)
                      : undefined;
                    const charRefs = character.generatedReferenceImages as any[] | null;
                    const charHasRefs = (charRefs?.length ?? 0) > 0 ||
                      ((character.referenceImages as any[] | null)?.length ?? 0) > 0;
                    const isReadyNoRefs = character.status === 'Ready' && !charHasRefs;
                    const isFailed = character.status === 'Failed';
                    const needsAction = isFailed || isReadyNoRefs;

                    const content = (
                      <div
                        className={`flex items-center gap-3 rounded-lg px-3 py-2${needsAction ? ' cursor-pointer hover:brightness-125' : ''}`}
                        style={{
                          border: isFailed
                            ? '1px solid var(--mantine-color-red-8)'
                            : '1px solid var(--mantine-color-dark-4)',
                          background: 'var(--mantine-color-dark-6)',
                        }}
                      >
                        {/* Thumbnail */}
                        <div
                          className="flex-shrink-0 rounded-md overflow-hidden"
                          style={{
                            width: 40,
                            height: 40,
                            background: 'var(--mantine-color-dark-7)',
                          }}
                        >
                          {isFailed ? (
                            <div className="w-full h-full flex items-center justify-center">
                              <IconAlertTriangle size={18} style={{ color: 'var(--mantine-color-red-6)' }} />
                            </div>
                          ) : coverImage ? (
                            <EdgeMedia2
                              src={coverImage.url}
                              type={coverImage.type as any}
                              metadata={coverImage.metadata}
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
                            <div className="w-full h-full flex items-center justify-center">
                              <IconUser size={18} style={{ color: 'var(--mantine-color-dark-3)' }} />
                            </div>
                          )}
                        </div>

                        {/* Name + status */}
                        <div className="flex-1 min-w-0">
                          <Text size="sm" fw={500} c="white" truncate>
                            {character.name}
                          </Text>
                          <Badge
                            size="xs"
                            variant="light"
                            color={
                              isFailed
                                ? 'red'
                                : isReadyNoRefs
                                  ? 'orange'
                                  : character.status === 'Ready'
                                    ? 'green'
                                    : character.status === 'Processing'
                                      ? 'yellow'
                                      : 'gray'
                            }
                          >
                            {isFailed
                              ? 'Failed — fix'
                              : isReadyNoRefs
                                ? 'No refs'
                                : character.status === 'Processing'
                                  ? 'Generating refs...'
                                  : character.status}
                          </Badge>
                        </div>
                      </div>
                    );

                    if (needsAction) {
                      return (
                        <Link
                          key={character.id}
                          href={`/comics/project/${projectId}/character`}
                          style={{ textDecoration: 'none' }}
                        >
                          {content}
                        </Link>
                      );
                    }

                    return <div key={character.id}>{content}</div>;
                  })
                )}
              </Stack>
            </Grid.Col>

            {/* Main - Panels */}
            <Grid.Col span={{ base: 12, md: 9 }}>
              <Stack gap="md">
                {/* Chapter tabs */}
                {project.chapters.length > 0 && (
                  <Group justify="space-between">
                    <Tabs
                      value={activeChapterId ?? project.chapters[0]?.id}
                      onChange={(v) => setActiveChapterId(v)}
                      variant="outline"
                    >
                      <Tabs.List>
                        {project.chapters.map((chapter) => (
                          <Tabs.Tab key={chapter.id} value={chapter.id}>
                            {chapter.name}
                          </Tabs.Tab>
                        ))}
                      </Tabs.List>
                    </Tabs>
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant="subtle"
                        leftSection={<IconPlus size={14} />}
                        onClick={() =>
                          createChapterMutation.mutate({ projectId })
                        }
                        loading={createChapterMutation.isPending}
                      >
                        Add Chapter
                      </Button>
                    </Group>
                  </Group>
                )}

                <Group justify="space-between">
                  <Text fw={500}>Panels</Text>
                  <Button
                    size="sm"
                    leftSection={<IconPlus size={14} />}
                    onClick={openPanelModal}
                    disabled={!activeCharacter || !activeChapter || !activeCharacterHasRefs}
                  >
                    Add Panel
                  </Button>
                </Group>

                {!activeCharacter && project.characters.length === 0 && (
                  <Card withBorder p="xl" className="text-center">
                    <Stack align="center" gap="md">
                      <Text c="dimmed">Add a character first to start generating panels</Text>
                      <Button component={Link} href={`/comics/project/${projectId}/character`}>
                        Add Character
                      </Button>
                    </Stack>
                  </Card>
                )}

                {!activeCharacter && project.characters.length > 0 && (
                  <Card withBorder p="md">
                    <Text c="dimmed" size="sm">
                      Wait for your character to finish processing before generating panels.
                    </Text>
                  </Card>
                )}

                {activeCharacter && !activeCharacterHasRefs && (
                  <Card withBorder p="md">
                    <Group justify="space-between">
                      <Text c="dimmed" size="sm">
                        {activeCharacter.name} needs reference images before generating panels.
                      </Text>
                      <Button
                        size="xs"
                        variant="light"
                        component={Link}
                        href={`/comics/project/${projectId}/character`}
                      >
                        Add References
                      </Button>
                    </Group>
                  </Card>
                )}

                {activeChapter && activeChapter.panels.length === 0 && activeCharacter && (
                  <Card withBorder p="xl" className="text-center">
                    <Stack align="center" gap="md">
                      <IconPhoto size={48} className="text-gray-500" />
                      <Text c="dimmed">No panels yet. Create your first panel!</Text>
                    </Stack>
                  </Card>
                )}

                <DndContext
                  sensors={panelSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handlePanelDragEnd}
                >
                  <SortableContext items={(activeChapter?.panels ?? []).map((p) => p.id)}>
                    <SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="md">
                      {(activeChapter?.panels ?? []).map((panel) => (
                        <SortablePanel key={panel.id} id={panel.id}>
                          <PanelCard
                            id={panel.id}
                            imageUrl={panel.imageUrl}
                            prompt={panel.prompt}
                            status={panel.status}
                            errorMessage={panel.errorMessage}
                            onDelete={() => deletePanelMutation.mutate({ panelId: panel.id })}
                            onViewDebug={() => {
                              setDebugPanelId(panel.id);
                              openDebugModal();
                            }}
                            onRegenerate={() => {
                              setRegeneratingPanelId(panel.id);
                              setPrompt(panel.prompt);
                              if (panel.characterId) setSelectedCharacterId(panel.characterId);
                              openPanelModal();
                            }}
                          />
                        </SortablePanel>
                      ))}
                    </SimpleGrid>
                  </SortableContext>
                </DndContext>
              </Stack>
            </Grid.Col>
          </Grid>
        </Stack>
      </Container>

      {/* Generate Panel Modal */}
      <Modal
        opened={panelModalOpened}
        onClose={() => {
          closePanelModal();
          setRegeneratingPanelId(null);
        }}
        title={regeneratingPanelId ? 'Regenerate Panel' : 'Generate Panel'}
        size="lg"
      >
        <Stack gap="md">
          {activeCharacter && (
            <Group>
              <Text size="sm" c="dimmed">
                Character:
              </Text>
              <Badge>{activeCharacter.name}</Badge>
            </Group>
          )}

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
          />

          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              Cost: 25 Buzz
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
              <Button
                onClick={handleGeneratePanel}
                loading={deletePanelMutation.isPending || createPanelMutation.isPending}
                disabled={!prompt.trim()}
              >
                Generate
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>

      {/* Debug Modal for failed panels */}
      <PanelDebugModal
        panelId={debugPanelId}
        opened={debugModalOpened}
        onClose={closeDebugModal}
      />
    </>
  );
}

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

interface PanelCardProps {
  id: string;
  imageUrl: string | null;
  prompt: string;
  status: string;
  errorMessage: string | null;
  onDelete: () => void;
  onViewDebug: () => void;
  onRegenerate: () => void;
}

function PanelCard({ id, imageUrl, prompt, status, errorMessage, onDelete, onViewDebug, onRegenerate }: PanelCardProps) {
  return (
    <Card withBorder padding="xs" className="aspect-[3/4] relative group">
      {imageUrl ? (
        <Image src={getEdgeUrl(imageUrl, { width: 450 })} alt={prompt} className="w-full h-full object-cover rounded" />
      ) : (
        <div className="w-full h-full bg-gray-800 rounded flex items-center justify-center">
          {status === 'Generating' || status === 'Pending' ? (
            <Stack align="center" gap="xs">
              <div className="animate-spin">
                <IconRefresh size={24} className="text-gray-500" />
              </div>
              <Text size="xs" c="dimmed">
                {status === 'Pending' ? 'Queued' : 'Generating...'}
              </Text>
            </Stack>
          ) : status === 'Failed' ? (
            <Stack align="center" gap="xs">
              <IconAlertTriangle size={32} className="text-red-500" />
              <Text size="xs" c="red">
                Failed
              </Text>
              {errorMessage && (
                <Text size="xs" c="dimmed" ta="center" lineClamp={2} px="xs">
                  {errorMessage}
                </Text>
              )}
            </Stack>
          ) : (
            <IconPhoto size={32} className="text-gray-600" />
          )}
        </div>
      )}

      {/* Hover overlay with actions */}
      <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity rounded flex items-start justify-end p-2">
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="filled" color="dark" size="sm">
              <IconDotsVertical size={14} />
            </ActionIcon>
          </Menu.Target>

          <Menu.Dropdown>
            {(status === 'Ready' || status === 'Failed') && (
              <Menu.Item leftSection={<IconRefreshDot size={14} />} onClick={onRegenerate}>
                Regenerate
              </Menu.Item>
            )}
            <Menu.Item leftSection={<IconBug size={14} />} onClick={onViewDebug}>
              View Debug Info
            </Menu.Item>
            <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={onDelete}>
              Delete
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </div>

      {/* Prompt tooltip */}
      <Tooltip label={prompt} multiline maw={300}>
        <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/80 to-transparent rounded-b opacity-0 group-hover:opacity-100 transition-opacity">
          <Text size="xs" c="white" truncate>
            {prompt}
          </Text>
        </div>
      </Tooltip>
    </Card>
  );
}

// Debug modal for viewing panel generation details
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
            {/* Error (prominent at top) */}
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

            {/* Original vs Enhanced prompt */}
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

            {/* Previous panel context */}
            {meta?.previousPanelId && (
              <div>
                <Text fw={600} size="sm" mb={4}>
                  Previous Panel Context
                </Text>
                <Stack gap="xs">
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">ID:</Text>
                    <Code>{meta.previousPanelId}</Code>
                  </Group>
                  {meta.previousPanelPrompt && (
                    <div>
                      <Text size="xs" c="dimmed" mb={2}>Prompt used</Text>
                      <Code block>{meta.previousPanelPrompt}</Code>
                    </div>
                  )}
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">Had image:</Text>
                    <Badge size="xs" variant="light" color={meta.previousPanelImageUrl ? 'green' : 'gray'}>
                      {meta.previousPanelImageUrl ? 'Yes' : 'No'}
                    </Badge>
                  </Group>
                </Stack>
              </div>
            )}

            {/* Reference images sent to orchestrator */}
            {meta?.referenceImages && meta.referenceImages.length > 0 && (
              <div>
                <Text fw={600} size="sm" mb={4}>
                  Reference Images ({meta.referenceImages.length})
                </Text>
                <Stack gap="xs">
                  {(meta.referenceImages as { url: string; width: number; height: number }[]).map(
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

            {/* Character info */}
            <div>
              <Text fw={600} size="sm" mb={4}>
                Character
              </Text>
              {meta?.characterName ? (
                <Stack gap="xs">
                  <Group gap="xs">
                    <Text size="xs" c="dimmed">Active:</Text>
                    <Text size="xs">{meta.characterName}</Text>
                  </Group>
                  {meta.allCharacterNames && (
                    <Group gap="xs">
                      <Text size="xs" c="dimmed">All:</Text>
                      <Text size="xs">{(meta.allCharacterNames as string[]).join(', ')}</Text>
                    </Group>
                  )}
                  {data.character && (
                    <Group gap="xs">
                      <Text size="xs" c="dimmed">Source:</Text>
                      <Badge size="xs" variant="light">{data.character.sourceType}</Badge>
                    </Group>
                  )}
                </Stack>
              ) : data.character ? (
                <Code block>{JSON.stringify(data.character, null, 2)}</Code>
              ) : (
                <Text size="xs" c="dimmed">No character info</Text>
              )}
            </div>

            {/* Generation parameters */}
            <div>
              <Text fw={600} size="sm" mb={4}>
                Generation Parameters
              </Text>
              {meta?.generationParams ? (
                <Code block>{JSON.stringify(meta.generationParams, null, 2)}</Code>
              ) : (
                <Code block>{JSON.stringify(data.generation, null, 2)}</Code>
              )}
            </div>

            {/* Panel record */}
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

            {/* Orchestrator workflow */}
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

export default Page(ProjectWorkspace, { withScrollArea: false });
