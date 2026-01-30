import {
  Button,
  Card,
  Container,
  Grid,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { IconPhoto, IconPlus } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';

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

function ComicsDashboard() {
  const router = useRouter();
  const [opened, { open, close }] = useDisclosure(false);
  const [projectName, setProjectName] = useState('');

  const { data: projects, isLoading } = trpc.comics.getMyProjects.useQuery();

  const createProjectMutation = trpc.comics.createProject.useMutation({
    onSuccess: (project) => {
      close();
      setProjectName('');
      router.push(`/comics/project/${project.id}`);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectName.trim()) return;
    createProjectMutation.mutate({ name: projectName.trim() });
  };

  return (
    <>
      <Meta
        title="Civitai Comics"
        description="Create comics with consistent AI-generated characters"
      />

      <Container size="xl" py="xl">
        <Stack gap="xl">
          <Group justify="space-between">
            <div>
              <Title order={1}>My Comics</Title>
              <Text c="dimmed">Create and manage your comic projects</Text>
            </div>
            <Button leftSection={<IconPlus size={16} />} onClick={open}>
              New Project
            </Button>
          </Group>

          {isLoading ? (
            <Text c="dimmed">Loading projects...</Text>
          ) : projects?.length === 0 ? (
            <Card withBorder p="xl" className="text-center">
              <Stack align="center" gap="md">
                <IconPhoto size={48} className="text-gray-500" />
                <Text c="dimmed">No projects yet</Text>
                <Button onClick={open}>Create your first comic</Button>
              </Stack>
            </Card>
          ) : (
            <Grid>
              {projects?.map((project) => (
                <Grid.Col key={project.id} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
                  <ProjectCard
                    id={project.id}
                    name={project.name}
                    description={project.description}
                    coverImageUrl={project.coverImageUrl}
                    panelCount={project.panelCount}
                    thumbnailUrl={project.thumbnailUrl}
                    updatedAt={project.updatedAt}
                  />
                </Grid.Col>
              ))}
            </Grid>
          )}
        </Stack>
      </Container>

      <Modal opened={opened} onClose={close} title="New Project">
        <form onSubmit={handleSubmit}>
          <Stack>
            <TextInput
              label="Project name"
              placeholder="My Comic"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
            />
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={createProjectMutation.isPending}
                disabled={!projectName.trim()}
              >
                Create Project
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
}

interface ProjectCardProps {
  id: string;
  name: string;
  description: string | null;
  coverImageUrl: string | null;
  panelCount: number;
  thumbnailUrl: string | null;
  updatedAt: Date;
}

function ProjectCard({ id, name, description, coverImageUrl, panelCount, thumbnailUrl, updatedAt }: ProjectCardProps) {
  const router = useRouter();
  const imageUrl = coverImageUrl ?? thumbnailUrl;

  return (
    <Card
      withBorder
      padding="lg"
      className="h-56 cursor-pointer hover:border-blue-500 transition-colors"
      onClick={() => router.push(`/comics/project/${id}`)}
    >
      <Stack justify="space-between" className="h-full">
        <div>
          {imageUrl ? (
            <div className="w-full h-20 rounded mb-2 overflow-hidden">
              <img
                src={getEdgeUrl(imageUrl, { width: 450 })}
                alt={name}
                className="w-full h-full object-cover"
              />
            </div>
          ) : (
            <div className="w-full h-20 bg-gray-800 rounded mb-2 flex items-center justify-center">
              <IconPhoto size={24} className="text-gray-600" />
            </div>
          )}
          <Text fw={500} truncate>
            {name}
          </Text>
          {description && (
            <Text size="xs" c="dimmed" lineClamp={1}>
              {description}
            </Text>
          )}
          <Text size="sm" c="dimmed">
            {panelCount} {panelCount === 1 ? 'panel' : 'panels'}
          </Text>
        </div>
        <Text size="xs" c="dimmed">
          Updated {formatDate(updatedAt)}
        </Text>
      </Stack>
    </Card>
  );
}

function formatDate(date: Date): string {
  const now = new Date();
  const d = new Date(date);
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString();
}

export default Page(ComicsDashboard, { withScrollArea: false });
