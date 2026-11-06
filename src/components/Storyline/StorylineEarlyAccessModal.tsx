import { Badge, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useStorylineEarlyAccess } from '~/components/Storyline/storyline.queries';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';

export function StorylineEarlyAccessModal({
  storylineId,
}: {
  chapterId: number;
  storylineId: number;
}) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const earlyAccess = useStorylineEarlyAccess();
  const [joinedNow, setJoinedNow] = useState(false);
  const joined = earlyAccess.joined || joinedNow;

  const handleJoin = async () => {
    try {
      await earlyAccess.join({ storylineId });
      setJoinedNow(true);
    } catch (error) {
      showErrorNotification({ title: 'Could not join early access', error: error as Error });
    }
  };

  return (
    <Modal
      {...dialog}
      centered
      title={
        <Group gap="xs">
          <Text fw={700}>Story tool early access</Text>
          <Badge variant="outline" color="violet">
            Coming soon
          </Badge>
        </Group>
      }
    >
      {joined ? (
        <Stack gap="sm">
          <Group gap="xs">
            <IconCheck size={18} color="var(--mantine-color-green-6)" />
            <Text fw={600}>You are on the list.</Text>
          </Group>
          <Text size="sm" c="dimmed">
            Early access testers get the storyline tool first.
          </Text>
          <Button onClick={dialog.onClose}>Done</Button>
        </Stack>
      ) : (
        <Stack gap="sm">
          <Text size="sm">
            A tool for building storylines is being built. You will pick up from here with the story
            so far loaded, add an image, a video or a sequence, and publish it as the next section.
            To add a chapter today, write it as a post.
          </Text>
          <Text size="sm" c="dimmed">
            Want to try it first?
          </Text>
          <Group>
            {currentUser ? (
              <Button onClick={handleJoin} loading={earlyAccess.isJoining}>
                Get early access
              </Button>
            ) : (
              <LoginRedirect reason="storyline-early-access">
                <Button>Sign in for early access</Button>
              </LoginRedirect>
            )}
            <Button variant="default" onClick={dialog.onClose}>
              Not now
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
