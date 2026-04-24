import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconCheck, IconExternalLink, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    const isModerator = session?.user?.isModerator ?? false;
    if (!isModerator) return { notFound: true };
    return { props: {} };
  },
});

export default function FeaturedCollectionsAdmin() {
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.homeBlock.getFeaturedCollectionsPool.useQuery();

  const [collectionIdInput, setCollectionIdInput] = useState<number | ''>('');

  const addMutation = trpc.homeBlock.addCollectionToFeaturedPool.useMutation({
    async onSuccess() {
      showSuccessNotification({ title: 'Added', message: 'Collection added to featured pool' });
      setCollectionIdInput('');
      await queryUtils.homeBlock.getFeaturedCollectionsPool.invalidate();
    },
    onError(error) {
      showErrorNotification({ title: 'Failed to add', error: new Error(error.message) });
    },
  });

  const removeMutation = trpc.homeBlock.removeCollectionFromFeaturedPool.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Removed',
        message: 'Collection removed from featured pool',
      });
      await queryUtils.homeBlock.getFeaturedCollectionsPool.invalidate();
    },
    onError(error) {
      showErrorNotification({ title: 'Failed to remove', error: new Error(error.message) });
    },
  });

  const acknowledgeMutation = trpc.homeBlock.acknowledgeFeaturedCollectionName.useMutation({
    async onSuccess() {
      showSuccessNotification({
        title: 'Approved',
        message: 'New name approved — collection is eligible again',
      });
      await queryUtils.homeBlock.getFeaturedCollectionsPool.invalidate();
    },
    onError(error) {
      showErrorNotification({ title: 'Failed to approve', error: new Error(error.message) });
    },
  });

  const handleAdd = () => {
    if (typeof collectionIdInput !== 'number') return;
    addMutation.mutate({ collectionId: collectionIdInput });
  };

  if (isLoading) return <PageLoader />;

  const collections = data?.collections ?? [];

  return (
    <>
      <Meta
        title="Featured Collections — Moderator"
        canonical="/moderator/home-blocks/featured-collections"
        deIndex
      />
      <Stack gap="lg" className="container py-6">
        <div>
          <Title order={2}>Featured Collections</Title>
          <Text c="dimmed" size="sm">
            Collections in this pool are rotated randomly on the homepage Featured Collections
            block. Content is already clamped to PG/PG-13 at render time — but curate collections
            whose full contents are appropriate.
          </Text>
        </div>

        <Card withBorder padding="md">
          <Group align="flex-end">
            <NumberInput
              label="Add collection by ID"
              placeholder="e.g. 107"
              value={collectionIdInput}
              onChange={(v) => setCollectionIdInput(typeof v === 'number' ? v : '')}
              hideControls
              min={1}
              style={{ flex: 1, maxWidth: 240 }}
            />
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={handleAdd}
              loading={addMutation.isLoading}
              disabled={typeof collectionIdInput !== 'number'}
            >
              Add
            </Button>
          </Group>
          <Text c="dimmed" size="xs" mt="xs">
            Tip: mods can also add via the {`"Feature on homepage"`} item in any collection{`'`}s
            context menu.
          </Text>
        </Card>

        {collections.length === 0 ? (
          <Card withBorder padding="lg">
            <Text c="dimmed">No collections in the featured pool yet.</Text>
          </Card>
        ) : (
          <Stack gap="sm">
            {collections.map((c) => {
              const coverUrl = c.image
                ? getEdgeUrl(c.image.url, { width: 96, name: c.image.id.toString() })
                : null;
              return (
                <Card key={c.id} withBorder padding="sm">
                  <Group justify="space-between" wrap="nowrap">
                    <Group wrap="nowrap">
                      {coverUrl ? (
                        <img
                          src={coverUrl}
                          alt={c.name}
                          width={64}
                          height={64}
                          style={{ borderRadius: 6, objectFit: 'cover' }}
                        />
                      ) : (
                        <div
                          style={{
                            width: 64,
                            height: 64,
                            borderRadius: 6,
                            background: 'rgba(127,127,127,0.15)',
                          }}
                        />
                      )}
                      <Stack gap={2}>
                        <Group gap="xs">
                          <Text fw={600}>{c.name}</Text>
                          <Badge size="sm" variant="light">
                            {c.type ?? 'Mixed'}
                          </Badge>
                          <Badge size="sm" variant="outline" color="gray">
                            nsfwLevel {c.nsfwLevel}
                          </Badge>
                          <Badge size="sm" variant="outline" color="gray">
                            {c._count.items} items
                          </Badge>
                          {c.missing ? (
                            <Badge size="sm" color="gray" variant="filled">
                              Deleted — remove
                            </Badge>
                          ) : c.nameChanged ? (
                            <Badge size="sm" color="red" variant="filled">
                              Name changed — review
                            </Badge>
                          ) : (
                            <Badge
                              size="sm"
                              color={c.eligible ? 'teal' : 'yellow'}
                              variant={c.eligible ? 'filled' : 'light'}
                            >
                              {c.eligible ? 'Live' : 'Stale'}
                            </Badge>
                          )}
                        </Group>
                        <Text size="xs" c="dimmed">
                          by @{c.user.username} · id {c.id} · {c.recentCount} items in last 5d
                          {c.lastAcceptedAt
                            ? ` · last approval ${new Date(c.lastAcceptedAt).toLocaleDateString()}`
                            : ' · no approvals yet'}
                        </Text>
                        {c.nameChanged && (
                          <Text size="xs" c="red">
                            Approved as {`"`}
                            {c.approvedName}
                            {`"`} · now {`"`}
                            {c.name}
                            {`"`}
                          </Text>
                        )}
                      </Stack>
                    </Group>
                    <Group>
                      {c.nameChanged && (
                        <ActionIcon
                          color="teal"
                          variant="light"
                          title="Approve new name"
                          loading={acknowledgeMutation.isLoading}
                          onClick={() => acknowledgeMutation.mutate({ collectionId: c.id })}
                        >
                          <IconCheck size={16} />
                        </ActionIcon>
                      )}
                      <Link href={`/collections/${c.id}`} target="_blank" legacyBehavior>
                        <ActionIcon component="a" variant="subtle">
                          <IconExternalLink size={16} />
                        </ActionIcon>
                      </Link>
                      <PopConfirm
                        message={`Remove "${c.name}" from featured pool?`}
                        onConfirm={() => removeMutation.mutate({ collectionId: c.id })}
                        withinPortal
                      >
                        <ActionIcon color="red" variant="subtle" loading={removeMutation.isLoading}>
                          <IconTrash size={16} />
                        </ActionIcon>
                      </PopConfirm>
                    </Group>
                  </Group>
                </Card>
              );
            })}
          </Stack>
        )}
      </Stack>
    </>
  );
}
