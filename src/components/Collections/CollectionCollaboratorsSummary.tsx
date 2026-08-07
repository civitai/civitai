import { Avatar, Badge, Group, Popover, Stack, Text, UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CollectionCollaboratorRole } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

const MAX_AVATARS = 4;

const roleLabels: Record<CollectionCollaboratorRole, string> = {
  [CollectionCollaboratorRole.Contributor]: 'CONTRIBUTOR',
  [CollectionCollaboratorRole.Manager]: 'MANAGER',
};

// UserAvatar swaps between a Mantine Avatar and a Paper depending on whether the user has a
// profilePicture, so Avatar.Group's context-driven offset only reaches some entries. Own the
// overlap here instead, on a wrapper that every entry renders.
const stackEntry = '-ml-2 rounded-full ring-2 first:ml-0';

function CollaboratorAvatar({
  userId,
  withUsername,
  linkToProfile,
}: {
  userId: number;
  withUsername?: boolean;
  linkToProfile?: boolean;
}) {
  const { data } = trpc.user.getById.useQuery(
    { id: userId },
    { gcTime: Infinity, staleTime: Infinity }
  );

  // Handing UserAvatar a bare userId makes it render a spinner plus literal "Loading user..." text
  // for the whole round trip, which blows out the header's width and then collapses it.
  if (!data) return <Avatar size="sm" radius="xl" />;

  return (
    <UserAvatar user={data} size="sm" withUsername={withUsername} linkToProfile={linkToProfile} />
  );
}

export function CollectionCollaboratorsSummary({
  collectionId,
  owner,
  supportsCollaborators,
}: {
  collectionId: number;
  owner: { id: number; username?: string | null; image?: string | null };
  supportsCollaborators: boolean;
}) {
  const features = useFeatureFlags();
  // getCollaborators rejects curated (mode !== null) and system-owned collections outright, so
  // the query must never be issued for them rather than swallowing the error after the fact.
  const enabled = features.collaborativeCollections && supportsCollaborators && owner.id > 0;

  const { data } = trpc.collection.getCollaborators.useQuery({ id: collectionId }, { enabled });

  const collaborators = data?.collaborators ?? [];

  if (!enabled || !collaborators.length) {
    return <UserAvatar user={owner} withUsername linkToProfile />;
  }

  const shown = collaborators.slice(0, MAX_AVATARS - 1);
  const hidden = collaborators.length - shown.length;

  return (
    <Popover position="bottom-start" width={320} withinPortal zIndex={300} shadow="md">
      <Popover.Target>
        <UnstyledButton>
          <Group gap={8} wrap="nowrap">
            <Group gap={0} wrap="nowrap">
              <div className={clsx(stackEntry, 'ring-[var(--mantine-color-blue-filled)]')}>
                <UserAvatar user={owner} size="sm" />
              </div>
              {shown.map((c) => (
                <div
                  key={c.userId}
                  className={clsx(stackEntry, 'ring-[var(--mantine-color-body)]')}
                >
                  <CollaboratorAvatar userId={c.userId} />
                </div>
              ))}
              {hidden > 0 && (
                <div className={clsx(stackEntry, 'ring-[var(--mantine-color-body)]')}>
                  <Avatar size="sm" radius="xl">{`+${hidden}`}</Avatar>
                </div>
              )}
            </Group>
            {/* The count excludes the owner by design while the stack above includes them. */}
            <Text size="sm" fw={500}>
              {owner.username}{' '}
              <Text span c="dimmed" inherit fw={400}>
                and {collaborators.length} collaborator{collaborators.length === 1 ? '' : 's'}
              </Text>
            </Text>
          </Group>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Stack gap={0} p="xs">
          <Group justify="space-between" px={4} pb={6}>
            <Text size="sm" fw={600}>
              Collaborators
            </Text>
          </Group>
          <Group gap={8} px={4} py={6} wrap="nowrap">
            <UserAvatar user={owner} withUsername linkToProfile size="sm" />
            <Badge size="xs" variant="light" color="orange" ml="auto">
              OWNER
            </Badge>
          </Group>
          {collaborators.map((c) => (
            <Group key={c.userId} gap={8} px={4} py={6} wrap="nowrap">
              <CollaboratorAvatar userId={c.userId} withUsername linkToProfile />
              <Badge
                size="xs"
                variant="light"
                color={c.role === CollectionCollaboratorRole.Manager ? 'blue' : 'gray'}
                ml="auto"
              >
                {roleLabels[c.role]}
              </Badge>
            </Group>
          ))}
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
