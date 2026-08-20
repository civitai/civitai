import { Button, Card, Center, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { IconLayoutGrid, IconPlus, IconTrash } from '@tabler/icons-react';
import Link from 'next/link';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!features?.userHubs) return { notFound: true };
    if (!session?.user) return { redirect: { destination: '/login', permanent: false } };
  },
});

export default function HubsPage() {
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();
  const { data: hubs = [], isLoading } = trpc.userHub.getAll.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const createMutation = trpc.userHub.upsert.useMutation({
    onSuccess: () => utils.userHub.getAll.invalidate(),
  });
  // Tracks WHICH hub is being deleted: `isPending` alone is one flag for the whole
  // list, so deleting one hub spun the button on every row.
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const deleteMutation = trpc.userHub.delete.useMutation({
    onSuccess: () => utils.userHub.getAll.invalidate(),
    onSettled: () => setDeletingId(null),
  });

  if (!currentUser) return <NotFound />;

  return (
    <>
      <Meta title="My Hubs | Civitai" deIndex />
      <div className="container max-w-3xl py-6">
        <Group justify="space-between" mb="lg">
          <Title order={1}>My hubs</Title>
          <Button
            leftSection={<IconPlus size={16} />}
            loading={createMutation.isPending}
            onClick={() => createMutation.mutate({ name: 'New hub', sources: [] })}
          >
            New hub
          </Button>
        </Group>

        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : hubs.length === 0 ? (
          <Card withBorder p="xl">
            <Stack align="center" gap="xs">
              <IconLayoutGrid size={32} className="text-gray-5" />
              <Text fw={500}>You have no hubs yet</Text>
              <Text size="sm" c="dimmed" ta="center">
                A hub is a feed you compose yourself from the creators, models and collections you
                want to follow.
              </Text>
            </Stack>
          </Card>
        ) : (
          <Stack gap="xs">
            {hubs.map((hub) => (
              <Card key={hub.id} withBorder p="md">
                <Group justify="space-between" wrap="nowrap">
                  <Link href={`/hubs/${hub.id}`} className="flex-1">
                    <Text fw={600}>{hub.name}</Text>
                    <Text size="sm" c="dimmed">
                      {hub.sources.length === 0
                        ? 'No sources yet'
                        : `${hub.sources.length} source${hub.sources.length === 1 ? '' : 's'}`}
                    </Text>
                  </Link>
                  <PopConfirm
                    message={`Delete "${hub.name}"? Its sources go with it, and this cannot be undone.`}
                    onConfirm={() => {
                      setDeletingId(hub.id);
                      deleteMutation.mutate({ id: hub.id });
                    }}
                    confirmButtonColor="red"
                    width={260}
                    withArrow
                    withinPortal
                  >
                    <LegacyActionIcon
                      variant="subtle"
                      color="red"
                      aria-label={`Delete ${hub.name}`}
                      loading={deletingId === hub.id}
                    >
                      <IconTrash size={18} />
                    </LegacyActionIcon>
                  </PopConfirm>
                </Group>
              </Card>
            ))}
          </Stack>
        )}
      </div>
    </>
  );
}
