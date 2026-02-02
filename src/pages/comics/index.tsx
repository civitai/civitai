import {
  Button,
  Container,
  Group,
  Modal,
  Stack,
  TextInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconPhoto, IconPhotoOff, IconPlus } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';
import styles from './Comics.module.scss';

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

      <Container size="xl">
        <div className={styles.dashboardHeader}>
          <div>
            <h1 className={styles.browseTitle}>My Comics</h1>
            <p className={styles.browseSubtitle}>
              Create and manage your comic projects
            </p>
          </div>
          <button className={styles.dashboardNewBtn} onClick={open}>
            <IconPlus size={16} />
            New Project
          </button>
        </div>

        {isLoading ? (
          <div className={styles.loadingCenter}>
            <div className={styles.spinner} />
          </div>
        ) : projects?.length === 0 ? (
          <div className={styles.browseEmpty}>
            <IconPhotoOff size={48} />
            <p>No projects yet</p>
            <button className={styles.dashboardNewBtn} onClick={open}>
              <IconPlus size={16} />
              Create your first comic
            </button>
          </div>
        ) : (
          <div
            className="grid gap-5"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            }}
          >
            {projects?.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
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

type ProjectItem = RouterOutput['comics']['getMyProjects'][number];

function ProjectCard({ project }: { project: ProjectItem }) {
  const imageUrl = project.coverImageUrl ?? project.thumbnailUrl;

  return (
    <Link href={`/comics/project/${project.id}`} className={styles.comicCard}>
      <div className={styles.comicCardImage}>
        {imageUrl ? (
          <>
            <img
              src={getEdgeUrl(imageUrl, { width: 450 })}
              alt={project.name}
            />
            <div className={styles.comicCardOverlay}>
              <span className={styles.comicCardPanelBadge}>
                {project.panelCount} {project.panelCount === 1 ? 'panel' : 'panels'}
              </span>
            </div>
          </>
        ) : (
          <div className={styles.comicCardImageEmpty}>
            <IconPhoto size={36} />
          </div>
        )}
      </div>
      <div className={styles.comicCardBody}>
        <h3 className={styles.comicCardTitle}>{project.name}</h3>
        {project.description && (
          <p className={styles.comicCardDescription}>{project.description}</p>
        )}
        <p className={styles.comicCardTimestamp}>
          Updated {formatDate(project.updatedAt)}
        </p>
      </div>
    </Link>
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

export default Page(ComicsDashboard);
