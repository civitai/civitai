import { Alert, Button, Group, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
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
  const handlers = {
    onSuccess: () => utils.storyline.invalidate(),
    onError: (error: { message: string }) =>
      showErrorNotification({
        title: "Couldn't answer the invitation",
        error: new Error(error.message),
      }),
  };
  const accept = trpc.storyline.acceptInvite.useMutation(handlers);
  const decline = trpc.storyline.leave.useMutation(handlers);
  const busy = accept.isPending || decline.isPending;

  return (
    <Alert
      color="teal"
      icon={<IconRosetteDiscountCheck size={20} />}
      title={`${ownerUsername ?? 'The creator'} invited you to collaborate`}
    >
      <Text size="sm" mb="sm">
        Accept and you are listed as an endorsed collaborator: your continuations are added without
        review and shown ahead of others. Until then you are not listed on the storyline.
      </Text>
      <Group gap="xs">
        <Button
          size="xs"
          color="teal"
          loading={accept.isPending}
          disabled={busy}
          onClick={() => accept.mutate({ storylineId })}
        >
          Accept
        </Button>
        <Button
          size="xs"
          variant="default"
          loading={decline.isPending}
          disabled={busy}
          onClick={() => decline.mutate({ storylineId })}
        >
          Decline
        </Button>
      </Group>
    </Alert>
  );
}

/** An endorsed collaborator stepping down. Their chapters stay in the story. */
export function StorylineLeaveCollaboration({ storylineId }: { storylineId: number }) {
  const utils = trpc.useUtils();
  const leave = trpc.storyline.leave.useMutation({
    onSuccess: () => utils.storyline.invalidate(),
    onError: (error) =>
      showErrorNotification({ title: "Couldn't leave", error: new Error(error.message) }),
  });
  return (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <Text size="sm" c="dimmed">
        You are an endorsed collaborator on this storyline.
      </Text>
      <Button
        size="xs"
        variant="default"
        loading={leave.isPending}
        onClick={() =>
          openConfirmModal({
            title: 'Leave as collaborator',
            children: (
              <Text size="sm">
                Your chapters stay in the story; new continuations go to the creator&apos;s review.
              </Text>
            ),
            labels: { confirm: 'Leave', cancel: 'Cancel' },
            onConfirm: () => leave.mutate({ storylineId }),
          })
        }
      >
        Leave
      </Button>
    </Group>
  );
}
