import { Button, Container } from '@mantine/core';
import { IconPhoto, IconPhotoOff, IconPlus } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import { Page } from '~/components/AppLayout/Page';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { dbRead } from '~/server/db/client';
import { formatRelativeDate } from '~/utils/comic-helpers';
import type { RouterOutput } from '~/types/router';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ ctx }) => {
    const username = ctx.query.username as string;
    const user = await dbRead.user.findUnique({ where: { username }, select: { bannedAt: true } });
    if (user?.bannedAt)
      return {
        redirect: { destination: `/user/${username}`, permanent: true },
      };
  },
});

function UserComicsPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const username = router.query.username as string;
  const isSelf = currentUser?.username === username;

  const {
    data: projects,
    isLoading,
    isError,
    refetch,
  } = trpc.comics.getMyProjects.useQuery(undefined, { enabled: isSelf });

  if (!isSelf) {
    // For other users, show their public comics
    return <UserPublicComics username={username} />;
  }

  return (
    <Container size="xl" py="md">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">My Comics</h2>
        <Button
          leftSection={<IconPlus size={16} />}
          size="sm"
          component={Link}
          href="/comics/create"
        >
          New Project
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent" />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-3 py-12 text-gray-400">
          <IconPhotoOff size={48} />
          <p>Failed to load projects</p>
          <Button variant="default" onClick={() => refetch()}>
            Try Again
          </Button>
        </div>
      ) : projects?.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-gray-400">
          <IconPhotoOff size={48} />
          <p>No projects yet</p>
          <Button leftSection={<IconPlus size={16} />} component={Link} href="/comics/create">
            Create your first comic
          </Button>
        </div>
      ) : (
        <div
          className="grid gap-5"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
        >
          {projects?.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </Container>
  );
}

function UserPublicComics({ username }: { username: string }) {
  // TODO: query public comics for the user when a public user-specific query exists
  return (
    <Container size="xl" py="md">
      <div className="flex flex-col items-center gap-3 py-12 text-gray-400">
        <IconPhotoOff size={48} />
        <p>No public comics yet</p>
      </div>
    </Container>
  );
}

type ProjectItem = RouterOutput['comics']['getMyProjects'][number];

function ProjectCard({ project }: { project: ProjectItem }) {
  const imageUrl = project.coverImage?.url ?? project.thumbnailUrl;

  return (
    <Link
      href={`/comics/project/${project.id}`}
      className="block overflow-hidden rounded-lg border border-gray-700 bg-gray-800 transition-colors hover:border-gray-500"
    >
      <div className="relative aspect-[3/4] bg-gray-900">
        {imageUrl ? (
          <img
            src={getEdgeUrl(imageUrl, { width: 450 })}
            alt={project.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <IconPhoto size={36} className="text-gray-600" />
          </div>
        )}
      </div>
      <div className="p-3">
        <h3 className="text-sm font-medium truncate">{project.name}</h3>
        <p className="mt-1 text-xs text-gray-400">
          Updated {formatRelativeDate(project.updatedAt)}
        </p>
      </div>
    </Link>
  );
}

export default Page(UserComicsPage, { getLayout: UserProfileLayout });
