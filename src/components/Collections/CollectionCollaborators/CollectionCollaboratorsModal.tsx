import {
  Alert,
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
import { IconBolt, IconSend, IconTrash, IconX } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { INVITE_EXPIRY_DAYS } from '~/server/services/collection-invite.utils';
import { useCollection } from '~/components/Collections/collection.utils';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import type { SearchIndexDataMap } from '~/components/Search/search.utils2';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';
import type { InviteBlockedReason } from '~/server/services/collection-collaborator.service';
import { CollectionCollaboratorRole } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// Mirrors COLLABORATOR_CAP / MANAGER_CAP from collection-collaborator.service —
// duplicated rather than imported so this client component doesn't pull in a server module.
const COLLABORATOR_CAP = 25;
const MANAGER_CAP = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const roleLabels: Record<CollectionCollaboratorRole, string> = {
  [CollectionCollaboratorRole.Contributor]: 'Contributor',
  [CollectionCollaboratorRole.Manager]: 'Manager',
};

export default function CollectionCollaboratorsModal({ collectionId }: { collectionId: number }) {
  const dialog = useDialogContext();
  const { collection } = useCollection(collectionId);

  return (
    <Modal
      {...dialog}
      title={collection?.name ? `Collaborators · ${collection.name}` : 'Collaborators'}
      size="lg"
    >
      <CollectionCollaboratorsPanel collectionId={collectionId} onDone={dialog.onClose} />
    </Modal>
  );
}

function CollectionCollaboratorsPanel({
  collectionId,
  onDone,
}: {
  collectionId: number;
  onDone: () => void;
}) {
  const currentUser = useCurrentUser();
  const { collection, permissions } = useCollection(collectionId);
  const { data, isLoading, isError } = trpc.collection.getCollaborators.useQuery({
    id: collectionId,
  });
  const utils = trpc.useUtils();

  const [selectedUser, setSelectedUser] = useState<{ id: number; username: string } | null>(null);
  const [role, setRole] = useState<CollectionCollaboratorRole>(
    CollectionCollaboratorRole.Contributor
  );

  const isOwner = permissions?.isOwner ?? false;
  const isModerator = currentUser?.isModerator ?? false;
  const canManage = permissions?.manage ?? false;
  const canGrantManager = isOwner || isModerator;
  const ownerId = collection?.user?.id;
  // Mirrors what the server will answer for: curated (any mode) and system-owned collections
  // carry staff rows that are an internal roster, not a collaboration, so both the roster and
  // the invite form are refused there.
  const supportsCollaborators = !collection?.mode && (ownerId ?? 0) > 0;

  const collaborators = data?.collaborators ?? [];
  const invites = data?.invites ?? [];
  const inviteBlockedReason = data?.inviteBlockedReason ?? null;

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

  // `inviteCollaborator` upserts and resets `createdAt`, so re-sending the same role restarts the
  // 7-day window and fires a fresh notification. Separate instance only so the toast can say what
  // happened — the invite form's would name whoever is selected there instead.
  const resendMutation = trpc.collection.inviteCollaborator.useMutation({
    onSuccess: async () => {
      showSuccessNotification({ message: 'Invite sent again' });
      await invalidateRoster();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not resend invite', error: new Error(error.message) }),
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
    if (targetUserId === ownerId) return false;
    if (targetUserId === currentUser?.id) return true;
    if (!canManage) return false;
    if (isOwner || isModerator) return true;
    return targetRole === CollectionCollaboratorRole.Contributor;
  };

  // Mirrors `countCollaborators`: seats are counted per user, not per row, and the person about
  // to be invited doesn't count against the cap they're about to occupy — re-inviting an existing
  // collaborator replaces their seat. Adding the two lists instead would double-count anyone who
  // holds a row and a pending invite, and refuse the last seat.
  const seats = new Set<number>();
  const managerSeats = new Set<number>();
  for (const seat of [...collaborators, ...invites]) {
    seats.add(seat.userId);
    if (seat.role === CollectionCollaboratorRole.Manager) managerSeats.add(seat.userId);
  }
  if (selectedUser) {
    seats.delete(selectedUser.id);
    managerSeats.delete(selectedUser.id);
  }

  const atCollaboratorCap = seats.size >= COLLABORATOR_CAP;
  const atManagerCap =
    role === CollectionCollaboratorRole.Manager && managerSeats.size >= MANAGER_CAP;
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

  if (collection && !supportsCollaborators) {
    return (
      <Alert color="gray" variant="light">
        This collection doesn&apos;t support collaborators.
      </Alert>
    );
  }

  return (
    <Stack gap="md">
      {canManage && !isLoading && inviteBlockedReason && (
        <InviteBlockedNotice reason={inviteBlockedReason} isOwner={isOwner} />
      )}

      {canManage && !isLoading && !inviteBlockedReason && (
        <Stack gap={6}>
          <Group gap="xs" align="flex-start" wrap="nowrap">
            <div className="min-w-0 grow">
              {selectedUser ? (
                <Group gap="xs" wrap="nowrap" h={36}>
                  <UserAvatar userId={selectedUser.id} withUsername size="sm" />
                  <LegacyActionIcon size="sm" onClick={() => setSelectedUser(null)}>
                    <IconX size={14} />
                  </LegacyActionIcon>
                </Group>
              ) : (
                <QuickSearchDropdown
                  disableInitialSearch
                  supportedIndexes={['users']}
                  showIndexSelect={false}
                  startingIndex="users"
                  dropdownItemLimit={10}
                  placeholder="Invite by username"
                  onItemSelected={(_entity, item) => {
                    const user = item as SearchIndexDataMap['users'][number];
                    setSelectedUser({ id: user.id, username: user.username ?? `User ${user.id}` });
                  }}
                  filters={excludedUserIds
                    .map((id) => `AND NOT id=${id}`)
                    .join(' ')
                    .slice(4)}
                />
              )}
            </div>
            <Select
              aria-label="Role"
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
              w={150}
            />
            <Tooltip label={capReason} disabled={!capReason}>
              <span>
                <Button
                  leftSection={<IconSend size={16} />}
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
          <Text size="xs" c="dimmed">
            Managers can invite Contributors. Only the owner can grant Manager or remove one.
          </Text>
        </Stack>
      )}

      <Divider />

      {isLoading ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : isError ? (
        <Alert color="red" variant="light">
          The collaborator roster could not be loaded.
        </Alert>
      ) : (
        <Stack gap={2}>
          <SectionLabel label="Members" count={collaborators.length + (collection?.user ? 1 : 0)} />
          {collection?.user && (
            <CollaboratorRow
              user={collection.user}
              userId={collection.user.id}
              subText="Collection owner"
              role="Owner"
            />
          )}
          {collaborators.map((collaborator) => (
            <CollaboratorRow
              key={collaborator.userId}
              userId={collaborator.userId}
              subText={roleLabels[collaborator.role]}
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
            <Text size="sm" c="dimmed" px={4} py={6}>
              No collaborators yet.
            </Text>
          )}
        </Stack>
      )}

      {canManage && !isError && invites.length > 0 && (
        <>
          <Divider />
          <Stack gap={2}>
            <SectionLabel label="Pending invites" count={invites.length} />
            {invites.map((invite) => {
              const expiresAt = new Date(
                new Date(invite.createdAt).getTime() + INVITE_EXPIRY_DAYS * DAY_MS
              );
              const expiringSoon = expiresAt.getTime() - Date.now() < DAY_MS;

              return (
                <Group key={invite.id} justify="space-between" wrap="nowrap" px={4} py={6}>
                  <UserAvatar
                    userId={invite.userId}
                    withUsername
                    size="sm"
                    subText={
                      <Text size="xs" c="dimmed" span>
                        {roleLabels[invite.role]} · sent <DaysFromNow date={invite.createdAt} />
                      </Text>
                    }
                    subTextForce
                  />
                  <Group gap="md" wrap="nowrap">
                    <Text size="xs" c={expiringSoon ? 'red.6' : 'yellow.6'}>
                      Expires <DaysFromNow date={expiresAt} />
                    </Text>
                    {/* Resend goes through `inviteCollaborator`, so it is refused wherever a new
                        invite would be: while collaboration is disabled, without the owner's
                        membership, or when a Manager reaches for a Manager seat. The invite form
                        above is hidden in the first two cases; this has to follow it. */}
                    {!inviteBlockedReason &&
                      (canGrantManager || invite.role !== CollectionCollaboratorRole.Manager) && (
                        <Button
                          variant="subtle"
                          size="compact-xs"
                          loading={
                            resendMutation.isPending &&
                            resendMutation.variables?.targetUserId === invite.userId
                          }
                          onClick={() =>
                            resendMutation.mutate({
                              collectionId,
                              targetUserId: invite.userId,
                              role: invite.role,
                            })
                          }
                        >
                          Resend
                        </Button>
                      )}
                    <Button
                      variant="subtle"
                      color="red"
                      size="compact-xs"
                      loading={
                        removeMutation.isPending &&
                        removeMutation.variables?.targetUserId === invite.userId
                      }
                      onClick={() =>
                        removeMutation.mutate({ collectionId, targetUserId: invite.userId })
                      }
                    >
                      Cancel
                    </Button>
                  </Group>
                </Group>
              );
            })}
          </Stack>
        </>
      )}

      <Divider />
      <Group justify="space-between" wrap="nowrap">
        <Text size="xs" c="dimmed">
          Followers are not collaborators and are never listed here.
        </Text>
        <Button variant="default" onClick={onDone}>
          Done
        </Button>
      </Group>
    </Stack>
  );
}

function InviteBlockedNotice({
  reason,
  isOwner,
}: {
  reason: InviteBlockedReason;
  isOwner: boolean;
}) {
  if (reason === 'collaboration-disabled') {
    return (
      <Alert color="gray" variant="light">
        This collection is not accepting new collaborators right now.
      </Alert>
    );
  }

  if (!isOwner) {
    return (
      <Alert color="yellow" variant="light">
        The collection owner needs an active membership before new collaborators can be added.
      </Alert>
    );
  }

  return (
    <Alert color="yellow" variant="light" icon={<IconBolt size={18} />}>
      <Group justify="space-between" gap="md" wrap="nowrap">
        <Text size="sm">
          Collaborators are a member feature. Upgrade to invite people to help run this collection.
        </Text>
        <Button component={Link} href="/pricing" size="compact-sm" className="shrink-0">
          Get a membership
        </Button>
      </Group>
    </Alert>
  );
}

function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <Group gap={8} px={4} pb={4}>
      <Text size="xs" fw={700} c="dimmed" tt="uppercase" className="tracking-wide">
        {label}
      </Text>
      <Text size="xs" c="dimmed">
        {count}
      </Text>
    </Group>
  );
}

function CollaboratorRow({
  user,
  userId,
  role,
  subText,
  removable,
  removing,
  onRemove,
}: {
  user?: Partial<UserWithCosmetics> | null;
  userId: number;
  role: string;
  subText?: string;
  removable?: boolean;
  removing?: boolean;
  onRemove?: () => void;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" px={4} py={6}>
      <UserAvatar
        user={user}
        userId={userId}
        withUsername
        size="sm"
        subText={
          subText ? (
            <Text size="xs" c="dimmed" span>
              {subText}
            </Text>
          ) : undefined
        }
        subTextForce
      />
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
