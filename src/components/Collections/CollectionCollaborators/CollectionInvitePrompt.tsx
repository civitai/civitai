import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconCheck, IconHourglass } from '@tabler/icons-react';
import { CollectionInviteCover } from '~/components/Collections/CollectionCollaborators/CollectionInviteCover';
import {
  inviteExpiry,
  inviterLabel,
  roleLabels,
  useRespondToInvite,
  usePendingInviteFor,
} from '~/components/Collections/CollectionCollaborators/collectionInvite.util';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { abbreviateNumber } from '~/utils/number-helpers';

/**
 * The `collection-invite-received` notification links here, and an invitee to a private collection
 * has no permission on it until they accept — so without this the link lands them on "you do not
 * have sufficient permissions" with no way to act. Renders on the collection page whenever the
 * viewer is holding a live invite for it, whether or not they can read it yet.
 */
export function CollectionInvitePrompt({ collectionId }: { collectionId: number }) {
  const invite = usePendingInviteFor(collectionId);
  const respondMutation = useRespondToInvite();

  if (!invite) return null;

  const { expiresAt, expiringSoon } = inviteExpiry(invite.createdAt);

  return (
    <Paper withBorder radius="sm" p="sm" className="border-blue-6 bg-white dark:bg-dark-5">
      <Group gap="sm" wrap="nowrap" align="center">
        <CollectionInviteCover collection={invite.collection} />
        <Stack gap={2} style={{ minWidth: 0 }} className="grow">
          <Text size="sm" fw={600} lineClamp={1}>
            {invite.collection.name}
          </Text>
          <Text size="xs" c="dimmed">
            {inviterLabel(invite.invitedBy)} invited you to collaborate as {roleLabels[invite.role]}{' '}
            · {abbreviateNumber(invite.collection.itemCount)} items ·{' '}
            {invite.collection.collaboratorCount} collaborator
            {invite.collection.collaboratorCount === 1 ? '' : 's'}
          </Text>
          <Text
            fz={11}
            c={expiringSoon ? 'red.6' : 'yellow.6'}
            className="flex items-center gap-[5px]"
          >
            <IconHourglass size={12} className="shrink-0" />
            <span>
              Expires <DaysFromNow date={expiresAt} />
            </span>
          </Text>
        </Stack>
        <Group gap={8} wrap="nowrap" className="shrink-0">
          <Button
            size="xs"
            radius="sm"
            color="success.5"
            leftSection={<IconCheck size={14} />}
            loading={respondMutation.isPending && respondMutation.variables?.accept === true}
            disabled={respondMutation.isPending}
            onClick={() => respondMutation.mutate({ inviteId: invite.id, accept: true })}
          >
            Accept
          </Button>
          <Button
            size="xs"
            radius="sm"
            variant="default"
            loading={respondMutation.isPending && respondMutation.variables?.accept === false}
            disabled={respondMutation.isPending}
            onClick={() => respondMutation.mutate({ inviteId: invite.id, accept: false })}
          >
            Decline
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}
