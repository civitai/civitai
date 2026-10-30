import { Alert, Button, Group, Text } from '@mantine/core';
import { IconRosetteDiscountCheck } from '@tabler/icons-react';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** The invitee's answer to the owner's invitation to collaborate. */
export function StorylineInviteAlert({
  storylineId,
  ownerUsername,
}: {
  storylineId: number;
  ownerUsername: string | null;
}) {
  const utils = trpc.useUtils();
  const respond = trpc.storyline.respondToInvite.useMutation({
    onSuccess: () => utils.storyline.invalidate(),
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't answer the invitation",
        error: new Error(error.message),
      }),
  });
  const answering = respond.isPending ? respond.variables?.accept : undefined;

  return (
    <Alert
      color="teal"
      icon={<IconRosetteDiscountCheck size={20} />}
      title={`${ownerUsername ?? 'The creator'} invited you to collaborate`}
    >
      <Text size="sm" mb="sm">
        Accept and you are listed as an endorsed collaborator: your continuations are added without
        review and shown ahead of others. Until then nobody sees the invitation but the two of you.
      </Text>
      <Group gap="xs">
        <Button
          size="xs"
          color="teal"
          loading={answering === true}
          disabled={respond.isPending}
          onClick={() => respond.mutate({ storylineId, accept: true })}
        >
          Accept
        </Button>
        <Button
          size="xs"
          variant="default"
          loading={answering === false}
          disabled={respond.isPending}
          onClick={() => respond.mutate({ storylineId, accept: false })}
        >
          Decline
        </Button>
      </Group>
    </Alert>
  );
}
