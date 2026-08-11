import { Alert, Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { IconCheck, IconHourglass, IconMail, IconPhoto } from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { INVITE_EXPIRY_DAYS } from '~/server/services/collection-invite.utils';
import { CollectionCollaboratorRole, MediaType } from '~/shared/utils/prisma/enums';
import type { CollectionMyInvite } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const roleLabels: Record<CollectionCollaboratorRole, string> = {
  [CollectionCollaboratorRole.Contributor]: 'Contributor',
  [CollectionCollaboratorRole.Manager]: 'Manager',
};

const DAY_MS = 24 * 60 * 60 * 1000;

function inviterLabel(invitedBy: CollectionMyInvite['invitedBy']) {
  if (!invitedBy.username || invitedBy.deletedAt) return 'Someone';
  return `@${invitedBy.username}`;
}

export function CollectionInviteList() {
  const currentUser = useCurrentUser();
  // The collections sidebar renders for signed-out visitors too, and getMyInvites is protected —
  // firing it anonymously surfaces the load-failure alert to someone who has no invites to load.
  const { data: invites, isError } = trpc.collection.getMyInvites.useQuery(undefined, {
    enabled: !!currentUser,
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
      <Group gap={6}>
        <IconMail size={16} className="text-blue-6 dark:text-blue-4" />
        <Text size="sm" fw="bold" tt="uppercase" c="blue">
          Invitations
        </Text>
        <Badge size="sm" variant="filled" color="blue" circle>
          {invites.length}
        </Badge>
      </Group>
      {invites.map((invite) => {
        const isResponding = respondMutation.variables?.inviteId === invite.id;
        const expiresAt = new Date(
          new Date(invite.createdAt).getTime() + INVITE_EXPIRY_DAYS * DAY_MS
        );
        const expiringSoon = expiresAt.getTime() - Date.now() < DAY_MS;

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
                <InviteCover collection={invite.collection} />
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

function InviteCover({ collection }: { collection: CollectionMyInvite['collection'] }) {
  const { image } = collection;

  if (!image)
    return (
      <div className="flex size-8 shrink-0 items-center justify-center rounded-sm border border-gray-3 bg-gray-1 dark:border-dark-4 dark:bg-dark-6">
        <IconPhoto size={16} className="text-gray-6 dark:text-dark-2" />
      </div>
    );

  return (
    <div className="relative size-8 shrink-0 overflow-hidden rounded-sm border border-gray-3 bg-gray-1 dark:border-dark-4 dark:bg-dark-6">
      <ImageGuard2 image={image} explain={false} connectType="collection" connectId={collection.id}>
        {(show) =>
          show ? (
            // A video cover goes through EdgeVideo, whose 80px play-button overlay swallows a
            // 32px tile. Request the transcoded still and render it as a plain image instead.
            <EdgeMedia
              src={image.url}
              type="image"
              transcode={image.type === MediaType.video}
              anim={false}
              width={64}
              alt=""
              className="size-full object-cover"
              placeholder="empty"
              loading="lazy"
            />
          ) : (
            <MediaHash {...image} />
          )
        }
      </ImageGuard2>
    </div>
  );
}
