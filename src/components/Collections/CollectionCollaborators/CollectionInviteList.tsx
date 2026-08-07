import { Alert, Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconPhoto } from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { INVITE_EXPIRY_DAYS } from '~/server/services/collection-invite.utils';
import { CollectionCollaboratorRole } from '~/shared/utils/prisma/enums';
import type { CollectionMyInvite } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const roleLabels: Record<CollectionCollaboratorRole, string> = {
  [CollectionCollaboratorRole.Contributor]: 'Contributor',
  [CollectionCollaboratorRole.Manager]: 'Manager',
};

const DAY_MS = 24 * 60 * 60 * 1000;

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
        const expiresAt = new Date(
          new Date(invite.createdAt).getTime() + INVITE_EXPIRY_DAYS * DAY_MS
        );
        const expiringSoon = expiresAt.getTime() - Date.now() < DAY_MS;

        return (
          <Paper key={invite.id} withBorder radius="sm" p="xs">
            <Stack gap={6}>
              <Group wrap="nowrap" gap="xs" align="flex-start">
                <InviteCover collection={invite.collection} />
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
              </Group>
              {/* Display only. The server drops expired invites from this query, so a client-side
                  clock that ran ahead must never hide a row the server still considers live. */}
              <Text size="xs" c={expiringSoon ? 'red.6' : 'yellow.6'}>
                Expires <DaysFromNow date={expiresAt} />
              </Text>
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
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

function InviteCover({ collection }: { collection: CollectionMyInvite['collection'] }) {
  const { image } = collection;

  if (!image)
    return (
      <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-gray-1 dark:bg-dark-6">
        <IconPhoto size={16} className="text-gray-6 dark:text-dark-2" />
      </div>
    );

  return (
    <div className="relative size-8 shrink-0 overflow-hidden rounded-sm bg-gray-1 dark:bg-dark-6">
      <ImageGuard2 image={image} explain={false} connectType="collection" connectId={collection.id}>
        {(show) =>
          show ? (
            <EdgeMedia
              src={image.url}
              type={image.type}
              width={64}
              className="size-full object-cover"
              placeholder="empty"
              loading="lazy"
              anim={false}
            />
          ) : (
            <MediaHash {...image} />
          )
        }
      </ImageGuard2>
    </div>
  );
}
