import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Container,
  Grid,
  Group,
  Image,
  Menu,
  Modal,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconArrowLeft,
  IconDotsVertical,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconUser,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';

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
  const [prompt, setPrompt] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);

  const { data: project, isLoading, refetch } = trpc.comics.getProject.useQuery(
    { id: projectId },
    { enabled: !!projectId }
  );

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
      refetch();
    },
  });

  const deletePanelMutation = trpc.comics.deletePanel.useMutation({
    onSuccess: () => refetch(),
  });

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

  const handleGeneratePanel = () => {
    if (!prompt.trim() || !activeCharacter) return;
    createPanelMutation.mutate({
      projectId,
      characterId: activeCharacter.id,
      prompt: prompt.trim(),
    });
  };

  return (
    <>
      <Meta title={`${project.name} - Civitai Comics`} />

      <Container size="xl" py="xl">
        <Stack gap="xl">
          {/* Header */}
          <Group>
            <ActionIcon variant="subtle" component={Link} href="/comics">
              <IconArrowLeft size={20} />
            </ActionIcon>
            <Title order={2}>{project.name}</Title>
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
                    return (
                      <div
                        key={character.id}
                        className="flex items-center gap-3 rounded-lg px-3 py-2"
                        style={{
                          border: '1px solid var(--mantine-color-dark-4)',
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
                          {coverImage ? (
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
                              character.status === 'Ready'
                                ? 'green'
                                : character.status === 'Processing'
                                  ? 'yellow'
                                  : character.status === 'Failed'
                                    ? 'red'
                                    : 'gray'
                            }
                          >
                            {character.status}
                          </Badge>
                        </div>
                      </div>
                    );
                  })
                )}
              </Stack>
            </Grid.Col>

            {/* Main - Panels */}
            <Grid.Col span={{ base: 12, md: 9 }}>
              <Stack gap="md">
                <Group justify="space-between">
                  <Text fw={500}>Panels</Text>
                  <Button
                    size="sm"
                    leftSection={<IconPlus size={14} />}
                    onClick={openPanelModal}
                    disabled={!activeCharacter}
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

                {project.panels.length === 0 && activeCharacter && (
                  <Card withBorder p="xl" className="text-center">
                    <Stack align="center" gap="md">
                      <IconPhoto size={48} className="text-gray-500" />
                      <Text c="dimmed">No panels yet. Create your first panel!</Text>
                    </Stack>
                  </Card>
                )}

                <Grid>
                  {project.panels.map((panel) => (
                    <Grid.Col key={panel.id} span={{ base: 6, sm: 4, lg: 3 }}>
                      <PanelCard
                        id={panel.id}
                        imageUrl={panel.imageUrl}
                        prompt={panel.prompt}
                        status={panel.status}
                        onDelete={() => deletePanelMutation.mutate({ panelId: panel.id })}
                      />
                    </Grid.Col>
                  ))}
                </Grid>
              </Stack>
            </Grid.Col>
          </Grid>
        </Stack>
      </Container>

      {/* Generate Panel Modal */}
      <Modal opened={panelModalOpened} onClose={closePanelModal} title="Generate Panel" size="lg">
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

          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              Cost: 25 Buzz
            </Text>
            <Group>
              <Button variant="default" onClick={closePanelModal}>
                Cancel
              </Button>
              <Button
                onClick={handleGeneratePanel}
                loading={createPanelMutation.isPending}
                disabled={!prompt.trim()}
              >
                Generate
              </Button>
            </Group>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

interface PanelCardProps {
  id: string;
  imageUrl: string | null;
  prompt: string;
  status: string;
  onDelete: () => void;
}

function PanelCard({ id, imageUrl, prompt, status, onDelete }: PanelCardProps) {
  return (
    <Card withBorder padding="xs" className="aspect-[3/4] relative group">
      {imageUrl ? (
        <Image src={imageUrl} alt={prompt} className="w-full h-full object-cover rounded" />
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
              <IconPhoto size={32} className="text-red-500" />
              <Text size="xs" c="red">
                Failed
              </Text>
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

export default Page(ProjectWorkspace, { withScrollArea: false });
