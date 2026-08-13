import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { IconCheck, IconHourglass, IconMailOff } from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { CollectionInviteCover } from '~/components/Collections/CollectionCollaborators/CollectionInviteCover';
import {
  inviteExpiry,
  inviterLabel,
  roleLabels,
  useRespondToInvite,
} from '~/components/Collections/CollectionCollaborators/collectionInvite.util';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { INVITE_EXPIRY_DAYS } from '~/server/services/collection-invite.utils';
import { CollectionCollaboratorRole } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export default function CollectionInvitesModal() {
  const dialog = useDialogContext();
  const { data: invites, isLoading, isError } = trpc.collection.getMyInvites.useQuery();
  const respondMutation = useRespondToInvite();

  return (
    <Modal {...dialog} title="Invitations" size="xl">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          People who invited you to help run their collections. Invites expire {INVITE_EXPIRY_DAYS}{' '}
          days after they are sent.
        </Text>

        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : isError ? (
          <Alert color="red" variant="light">
            Your invitations could not be loaded.
          </Alert>
        ) : !invites?.length ? (
          <Stack gap="xs" align="center" py="xl">
            <IconMailOff size={32} className="text-gray-6 dark:text-dark-2" />
            <Text size="sm" c="dimmed">
              No pending invitations.
            </Text>
          </Stack>
        ) : (
          invites.map((invite) => {
            const isResponding = respondMutation.variables?.inviteId === invite.id;
            const { expiresAt, expiringSoon } = inviteExpiry(invite.createdAt);
            const { collection } = invite;

            return (
              <Paper key={invite.id} withBorder radius="sm" p="sm">
                <Group wrap="nowrap" gap="sm" align="center">
                  <CollectionInviteCover collection={collection} size={64} />
                  <Stack gap={4} className="min-w-0 grow">
                    <Group gap="xs" wrap="nowrap" className="min-w-0">
                      <Text fw={600} lineClamp={1} className="min-w-0">
                        {collection.name}
                      </Text>
                      <Badge
                        size="sm"
                        variant="light"
                        className="shrink-0"
                        color={invite.role === CollectionCollaboratorRole.Manager ? 'blue' : 'gray'}
                      >
                        {roleLabels[invite.role]}
                      </Badge>
                    </Group>
                    <Group gap={6} wrap="nowrap" className="min-w-0">
                      {invite.invitedBy.username && !invite.invitedBy.deletedAt && (
                        <UserAvatar user={invite.invitedBy} size="xs" />
                      )}
                      <Text size="sm" c="dimmed" lineClamp={1} className="min-w-0">
                        {inviterLabel(invite.invitedBy)} invited you to collaborate
                      </Text>
                    </Group>
                    <Text size="xs" c="dimmed">
                      {abbreviateNumber(collection.itemCount)} items ·{' '}
                      {collection.collaboratorCount} collaborator
                      {collection.collaboratorCount === 1 ? '' : 's'}
                    </Text>
                  </Stack>
                  <Group gap="sm" wrap="nowrap" className="shrink-0">
                    <Text
                      size="sm"
                      c={expiringSoon ? 'red.6' : 'yellow.6'}
                      className="flex items-center gap-1 whitespace-nowrap"
                    >
                      <IconHourglass size={14} className="shrink-0" />
                      <span>
                        Expires <DaysFromNow date={expiresAt} />
                      </span>
                    </Text>
                    <Button
                      color="success.5"
                      leftSection={<IconCheck size={16} />}
                      loading={isResponding && respondMutation.variables?.accept === true}
                      disabled={respondMutation.isPending && !isResponding}
                      onClick={() => respondMutation.mutate({ inviteId: invite.id, accept: true })}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="default"
                      loading={isResponding && respondMutation.variables?.accept === false}
                      disabled={respondMutation.isPending && !isResponding}
                      onClick={() => respondMutation.mutate({ inviteId: invite.id, accept: false })}
                    >
                      Decline
                    </Button>
                  </Group>
                </Group>
              </Paper>
            );
          })
        )}

        <Group justify="space-between" wrap="nowrap">
          <Text size="xs" c="dimmed">
            Accepting adds the role&apos;s permissions to any access you already have.
          </Text>
          <Button variant="default" onClick={dialog.onClose}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
