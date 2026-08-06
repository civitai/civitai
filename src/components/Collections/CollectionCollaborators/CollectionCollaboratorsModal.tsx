import {
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { IconTrash, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { useCollection } from '~/components/Collections/collection.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import { CollectionCollaboratorRole } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// Mirrors COLLABORATOR_CAP / MANAGER_CAP from collection-collaborator.service —
// duplicated rather than imported so this client component doesn't pull in a server module.
const COLLABORATOR_CAP = 25;
const MANAGER_CAP = 5;

const roleLabels: Record<CollectionCollaboratorRole, string> = {
  [CollectionCollaboratorRole.Contributor]: 'Contributor',
  [CollectionCollaboratorRole.Manager]: 'Manager',
};

export default function CollectionCollaboratorsModal({ collectionId }: { collectionId: number }) {
  const dialog = useDialogContext();

  return (
    <Modal {...dialog} title="Collaborators" size="lg">
      <CollectionCollaboratorsPanel collectionId={collectionId} />
    </Modal>
  );
}

function CollectionCollaboratorsPanel({ collectionId }: { collectionId: number }) {
  const currentUser = useCurrentUser();
  const { collection, permissions } = useCollection(collectionId);
  const { data, isLoading } = trpc.collection.getCollaborators.useQuery({ id: collectionId });
  const utils = trpc.useUtils();

  const [selectedUser, setSelectedUser] = useState<{ id: number; username: string } | null>(null);
  const [role, setRole] = useState<CollectionCollaboratorRole>(
    CollectionCollaboratorRole.Contributor
  );

  const isOwner = permissions?.isOwner ?? false;
  const isModerator = currentUser?.isModerator ?? false;
  const canManage = permissions?.manage ?? false;
  const canGrantManager = isOwner || isModerator;

  const collaborators = data?.collaborators ?? [];
  const invites = data?.invites ?? [];

  const invalidateRoster = () => utils.collection.getCollaborators.invalidate({ id: collectionId });

  const inviteMutation = trpc.collection.inviteCollaborator.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: `Invited ${selectedUser?.username ?? 'user'}` });
      setSelectedUser(null);
      setRole(CollectionCollaboratorRole.Contributor);
      await invalidateRoster();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not send invite', error: new Error(error.message) }),
  });

  const removeMutation = trpc.collection.removeCollaborator.useMutation({
    onSuccess: () => invalidateRoster(),
    onError: (error) =>
      showErrorNotification({
        title: 'Could not remove collaborator',
        error: new Error(error.message),
      }),
  });

  const canRemove = (targetUserId: number, targetRole: CollectionCollaboratorRole) => {
    if (targetUserId === currentUser?.id) return true;
    if (!canManage) return false;
    if (isOwner || isModerator) return true;
    return targetRole === CollectionCollaboratorRole.Contributor;
  };

  const totalCount = collaborators.length + invites.length;
  const managerCount = [...collaborators, ...invites].filter(
    (c) => c.role === CollectionCollaboratorRole.Manager
  ).length;
  const atCollaboratorCap = totalCount >= COLLABORATOR_CAP;
  const atManagerCap = role === CollectionCollaboratorRole.Manager && managerCount >= MANAGER_CAP;
  const capReason = atCollaboratorCap
    ? `This collection already has ${COLLABORATOR_CAP} collaborators, the maximum allowed.`
    : atManagerCap
    ? `This collection already has ${MANAGER_CAP} managers, the maximum allowed.`
    : null;

  const excludedUserIds = [
    currentUser?.id,
    collection?.user?.id,
    ...collaborators.map((c) => c.userId),
    ...invites.map((i) => i.userId),
  ].filter((id): id is number => typeof id === 'number');

  return (
    <Stack gap="md">
      {isLoading ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : (
        <Stack gap={4}>
          {collection?.user && (
            <CollaboratorRow user={collection.user} userId={collection.user.id} role="Owner" />
          )}
          {collaborators.map((collaborator) => (
            <CollaboratorRow
              key={collaborator.userId}
              userId={collaborator.userId}
              role={roleLabels[collaborator.role]}
              removable={canRemove(collaborator.userId, collaborator.role)}
              removing={
                removeMutation.isPending &&
                removeMutation.variables?.targetUserId === collaborator.userId
              }
              onRemove={() =>
                removeMutation.mutate({ collectionId, targetUserId: collaborator.userId })
              }
            />
          ))}
          {!collaborators.length && (
            <Text size="sm" c="dimmed">
              No collaborators yet.
            </Text>
          )}
        </Stack>
      )}

      {canManage && (
        <>
          <Divider label="Pending invites" labelPosition="left" />
          {invites.length ? (
            <Stack gap={4}>
              {invites.map((invite) => (
                <CollaboratorRow
                  key={invite.id}
                  userId={invite.userId}
                  role={`${roleLabels[invite.role]} (pending)`}
                  removable={canRemove(invite.userId, invite.role)}
                  removing={
                    removeMutation.isPending &&
                    removeMutation.variables?.targetUserId === invite.userId
                  }
                  onRemove={() =>
                    removeMutation.mutate({ collectionId, targetUserId: invite.userId })
                  }
                />
              ))}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              No pending invites.
            </Text>
          )}

          <Divider label="Invite a collaborator" labelPosition="left" />
          <Stack gap="xs">
            <QuickSearchDropdown
              disableInitialSearch
              supportedIndexes={['users']}
              showIndexSelect={false}
              startingIndex="users"
              dropdownItemLimit={10}
              placeholder="Search for a member to invite"
              onItemSelected={(_entity, item) => {
                const user = item as SearchIndexDataMap['users'][number];
                setSelectedUser({ id: user.id, username: user.username ?? `User ${user.id}` });
              }}
              filters={excludedUserIds.map((id) => `AND NOT id=${id}`).join(' ').slice(4)}
            />
            {selectedUser && (
              <Group gap="xs">
                <Text size="sm" c="dimmed">
                  Inviting:
                </Text>
                <UserAvatar userId={selectedUser.id} withUsername size="sm" />
                <LegacyActionIcon size="sm" onClick={() => setSelectedUser(null)}>
                  <IconX size={14} />
                </LegacyActionIcon>
              </Group>
            )}
            <Group gap="xs" align="flex-end">
              <Select
                label="Role"
                value={role}
                onChange={(value) => value && setRole(value as CollectionCollaboratorRole)}
                data={
                  canGrantManager
                    ? [
                        { value: CollectionCollaboratorRole.Contributor, label: 'Contributor' },
                        { value: CollectionCollaboratorRole.Manager, label: 'Manager' },
                      ]
                    : [{ value: CollectionCollaboratorRole.Contributor, label: 'Contributor' }]
                }
                allowDeselect={false}
                w={160}
              />
              <Tooltip label={capReason} disabled={!capReason}>
                <span>
                  <Button
                    disabled={!selectedUser || !!capReason}
                    loading={inviteMutation.isPending}
                    onClick={() =>
                      selectedUser &&
                      inviteMutation.mutate({ collectionId, targetUserId: selectedUser.id, role })
                    }
                  >
                    Invite
                  </Button>
                </span>
              </Tooltip>
            </Group>
          </Stack>
        </>
      )}
    </Stack>
  );
}

function CollaboratorRow({
  user,
  userId,
  role,
  removable,
  removing,
  onRemove,
}: {
  user?: Partial<UserWithCosmetics> | null;
  userId: number;
  role: string;
  removable?: boolean;
  removing?: boolean;
  onRemove?: () => void;
}) {
  return (
    <Group justify="space-between" wrap="nowrap">
      <UserAvatar user={user} userId={userId} withUsername size="sm" />
      <Group gap={6} wrap="nowrap">
        <Badge size="sm" variant="light">
          {role}
        </Badge>
        {removable && onRemove && (
          <LegacyActionIcon size="sm" color="red" loading={removing} onClick={onRemove}>
            <IconTrash size={14} />
          </LegacyActionIcon>
        )}
      </Group>
    </Group>
  );
}
