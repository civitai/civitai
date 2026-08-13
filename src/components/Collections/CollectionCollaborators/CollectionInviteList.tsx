import { Alert, Anchor, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconCheck, IconHourglass, IconMail } from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { CollectionInviteCover } from '~/components/Collections/CollectionCollaborators/CollectionInviteCover';
import {
  inviteExpiry,
  inviterLabel,
  roleLabels,
  useRespondToInvite,
} from '~/components/Collections/CollectionCollaborators/collectionInvite.util';
import { openCollectionInvitesModal } from '~/components/Collections/CollectionCollaborators/openCollectionInvitesModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

// The sidebar is a peek, not the inbox: the rest live behind "View all".
const INLINE_LIMIT = 2;

export function CollectionInviteList() {
  const currentUser = useCurrentUser();
  // The collections sidebar renders for signed-out visitors too, and getMyInvites is protected —
  // firing it anonymously surfaces the load-failure alert to someone who has no invites to load.
  const { data: invites, isError } = trpc.collection.getMyInvites.useQuery(undefined, {
    enabled: !!currentUser,
  });
  const respondMutation = useRespondToInvite();

  if (isError) {
    return (
      <Alert color="red" variant="light" mx="xs" mb="md">
        Your invitations could not be loaded.
      </Alert>
    );
  }

  if (!invites?.length) return null;

  return (
    <Stack gap="xs" px="xs" pt="sm" mb="md">
      <Group gap={6} wrap="nowrap">
        <IconMail size={16} className="text-blue-6 dark:text-blue-4" />
        {/* No count here — the sidebar header's mail button already carries it, and that one has
            to stay because it is the only invitations affordance when this band is absent. */}
        <Text size="sm" fw="bold" tt="uppercase" c="blue">
          Invitations
        </Text>
        <Anchor
          component="button"
          type="button"
          size="sm"
          ml="auto"
          onClick={openCollectionInvitesModal}
        >
          View all
        </Anchor>
      </Group>
      {invites.slice(0, INLINE_LIMIT).map((invite) => {
        const isResponding = respondMutation.variables?.inviteId === invite.id;
        const { expiresAt, expiringSoon } = inviteExpiry(invite.createdAt);

        return (
          <Paper
            key={invite.id}
            withBorder
            radius="sm"
            p="xs"
            className="border-blue-6 bg-white dark:bg-dark-5"
          >
            <Stack gap={8}>
              <Group wrap="nowrap" gap={8} align="center">
                <CollectionInviteCover collection={invite.collection} />
                <Stack gap={1} style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600} lineClamp={1}>
                    {invite.collection.name}
                  </Text>
                  {/* Two lines: the sidebar is narrow enough that a one-line clamp drops the
                      role, which is the half of this sentence that carries the grant. */}
                  <Text size="xs" c="dimmed" lineClamp={2}>
                    {inviterLabel(invite.invitedBy)} invited you · {roleLabels[invite.role]}
                  </Text>
                </Stack>
              </Group>
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
              <Group grow gap={8}>
                <Button
                  size="xs"
                  h={26}
                  radius="sm"
                  color="success.5"
                  leftSection={<IconCheck size={14} />}
                  loading={isResponding && respondMutation.variables?.accept === true}
                  disabled={respondMutation.isPending && !isResponding}
                  onClick={() => respondMutation.mutate({ inviteId: invite.id, accept: true })}
                >
                  Accept
                </Button>
                <Button
                  size="xs"
                  h={26}
                  radius="sm"
                  variant="default"
                  loading={isResponding && respondMutation.variables?.accept === false}
                  disabled={respondMutation.isPending && !isResponding}
                  onClick={() => respondMutation.mutate({ inviteId: invite.id, accept: false })}
                >
                  Decline
                </Button>
              </Group>
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}
