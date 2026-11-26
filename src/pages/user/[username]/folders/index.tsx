import { ActionIcon, Button, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconFolderPlus, IconPencil } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useRef } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { FolderCard } from '~/components/Profile/Folders/FolderCard';
import { openManageFoldersModal } from '~/components/Profile/Folders/folder-dialogs';
import { useFolderCardActions } from '~/components/Profile/Folders/useFolderCardActions';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ProfileFolderRow } from '~/server/services/profile-folders.service';
import { getUserBannedAtByUsername } from '~/server/services/user-banned-at.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, features, ssg }) => {
    if (!features?.profileRedesign || !features?.profileFolders) return { notFound: true };

    const username = ctx.query.username as string;
    const user = await getUserBannedAtByUsername(username);
    if (user?.bannedAt) return { redirect: { destination: `/user/${username}`, permanent: false } };

    await Promise.all([
      ssg?.userProfile.get.prefetch({ username }),
      ssg?.userProfile.overview.prefetch({ username }),
    ]);
  },
});

function UserFoldersPage() {
  const router = useRouter();
  const username = (router.query.username as string) ?? '';
  const currentUser = useCurrentUser();
  const { data: user, isLoading } = trpc.userProfile.get.useQuery(
    { username },
    { enabled: !!username }
  );
  const { data, isLoading: foldersLoading } = trpc.profileFolders.getAll.useQuery(
    { userId: user?.id ?? 0 },
    { enabled: !!user }
  );
  const isOwner = !!user && currentUser?.id === user.id;
  const rows = data?.rows ?? [];
  const profileUser = { id: user?.id ?? 0, username: user?.username ?? username };
  const actions = useFolderCardActions({
    user: profileUser,
    rows,
    storedRows: data?.storedRows ?? null,
  });

  if (!username) return <NotFound />;
  if (isLoading || (user && foldersLoading))
    return (
      <Center mt="md">
        <Loader />
      </Center>
    );
  if (!user) return <NotFound />;

  const folderCount = rows.reduce((sum, row) => sum + row.folders.length, 0);

  return (
    <Stack gap="lg" py="md">
      <Group justify="space-between" align="center">
        <Title order={2} c="var(--mantine-color-bright)">
          Folders
        </Title>
        {isOwner && (
          <Button
            variant="default"
            radius="xl"
            leftSection={<IconPencil size={14} />}
            onClick={() => openManageFoldersModal({ userId: user.id })}
          >
            Manage folders
          </Button>
        )}
      </Group>

      {folderCount === 0 ? (
        <Stack align="center" gap="xs" py="xl">
          <Text c="dimmed" ta="center">
            {isOwner
              ? 'Folders gather your models, images and articles in one place on your profile.'
              : `${user.username} has no folders to show yet.`}
          </Text>
          {isOwner && (
            <Button
              leftSection={<IconFolderPlus size={16} />}
              onClick={() => openManageFoldersModal({ userId: user.id })}
            >
              Create your first folder
            </Button>
          )}
        </Stack>
      ) : (
        rows.map((row, i) =>
          row.folders.length ? (
            <FolderRow
              key={row.id ?? `unplaced-${i}`}
              row={row}
              user={profileUser}
              isOwner={isOwner}
              actions={isOwner ? actions : undefined}
            />
          ) : null
        )
      )}
    </Stack>
  );
}

function FolderRow({
  row,
  user,
  isOwner,
  actions,
}: {
  row: ProfileFolderRow;
  user: { id: number; username: string };
  isOwner: boolean;
  actions?: ReturnType<typeof useFolderCardActions>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = (direction: number) =>
    scroller.current?.scrollBy({ left: direction * 336, behavior: 'smooth' });

  return (
    <Stack gap="xs">
      {row.name && (
        <Text fw={700} size="lg" c="var(--mantine-color-bright)">
          {row.name}
        </Text>
      )}
      <div className="relative">
        <div ref={scroller} className="flex snap-x gap-4 overflow-x-auto pb-2">
          {row.folders.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              user={user}
              isOwner={isOwner}
              actions={actions}
            />
          ))}
        </div>
        {row.folders.length > 2 && (
          <>
            <ActionIcon
              className="absolute -left-3 top-1/2 z-30 -translate-y-1/2 @max-sm:hidden"
              size="xl"
              radius="xl"
              variant="filled"
              color="dark"
              aria-label="Scroll folders left"
              onClick={() => scroll(-1)}
            >
              <IconChevronLeft size={20} />
            </ActionIcon>
            <ActionIcon
              className="absolute -right-3 top-1/2 z-30 -translate-y-1/2 @max-sm:hidden"
              size="xl"
              radius="xl"
              variant="filled"
              color="dark"
              aria-label="Scroll folders right"
              onClick={() => scroll(1)}
            >
              <IconChevronRight size={20} />
            </ActionIcon>
          </>
        )}
      </div>
    </Stack>
  );
}

export default Page(UserFoldersPage, { getLayout: UserProfileLayout });
