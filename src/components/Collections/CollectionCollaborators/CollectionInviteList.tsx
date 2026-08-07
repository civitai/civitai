import { Alert, Badge, Button, Group, Stack, Text } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CollectionCollaboratorRole } from '~/shared/utils/prisma/enums';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const roleLabels: Record<CollectionCollaboratorRole, string> = {
  [CollectionCollaboratorRole.Contributor]: 'Contributor',
  [CollectionCollaboratorRole.Manager]: 'Manager',
};

export function CollectionInviteList() {
  const features = useFeatureFlags();
  const { data: invites, isError } = trpc.collection.getMyInvites.useQuery(undefined, {
    enabled: features.collaborativeCollections,
  });
  const utils = trpc.useUtils();

  const respondMutation = trpc.collection.respondToInvite.useMutation({
    onSuccess: async (_, { accept }) => {
      showSuccessNotification({ message: accept ? 'Invite accepted' : 'Invite declined' });
      await Promise.all([
        utils.collection.getMyInvites.invalidate(),
        utils.collection.getAllUser.invalidate(),
      ]);
    },
    onError: (error) =>
      showErrorNotification({
        title: 'Could not respond to invite',
        error: new Error(error.message),
      }),
  });

  if (!features.collaborativeCollections) return null;

  if (isError) {
    return (
      <Alert color="red" variant="light" mx="xs" mb="md">
        Your invitations could not be loaded.
      </Alert>
    );
  }

  if (!invites?.length) return null;

  return (
    <Stack gap="xs" px="xs" mb="md">
      <Text size="sm" fw="bold">
        Invitations
      </Text>
      {invites.map((invite) => {
        const isResponding = respondMutation.variables?.inviteId === invite.id;

        return (
          <Group key={invite.id} justify="space-between" wrap="nowrap" gap="xs">
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Text size="sm" fw={500} lineClamp={1}>
                {invite.collection.name}
              </Text>
              <Group gap={4} wrap="nowrap">
                <Badge size="xs" variant="light">
                  {roleLabels[invite.role]}
                </Badge>
                <Text size="xs" c="dimmed">
                  Invited by
                </Text>
                <UserAvatar userId={invite.invitedById} withUsername size="xs" />
              </Group>
            </Stack>
            <Group gap={4} wrap="nowrap">
              <Button
                size="compact-xs"
                loading={isResponding && respondMutation.variables?.accept === true}
                disabled={respondMutation.isPending && !isResponding}
                onClick={() => respondMutation.mutate({ inviteId: invite.id, accept: true })}
              >
                Accept
              </Button>
              <Button
                size="compact-xs"
                variant="default"
                loading={isResponding && respondMutation.variables?.accept === false}
                disabled={respondMutation.isPending && !isResponding}
                onClick={() => respondMutation.mutate({ inviteId: invite.id, accept: false })}
              >
                Decline
              </Button>
            </Group>
          </Group>
        );
      })}
    </Stack>
  );
}
