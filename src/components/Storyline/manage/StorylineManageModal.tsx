import { Alert, Badge, Button, Group, Loader, Modal, Tabs, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { STORYLINE_QUEUE_RECEIVED_URL } from '~/components/Placement/queue-routes';
import { StorylineCollaboratorsPanel } from '~/components/Storyline/manage/StorylineCollaboratorsPanel';
import { StorylineSettingsForm } from '~/components/Storyline/manage/StorylineSettingsForm';
import { useStorylineSpace } from '~/components/Storyline/storyline.data';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const showError = (title: string) => (error: { message: string }) =>
  showErrorNotification({ title, error: new Error(error.message) });

/** The creator's controls for one storyline: settings and endorsed collaborators. */
export default function StorylineManageModal({ storylineId }: { storylineId: number }) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const {
    data: storyline,
    isLoading,
    isError,
  } = trpc.storyline.getById.useQuery({
    id: storylineId,
  });
  const isOwner = !!currentUser && storyline?.userId === currentUser.id;
  const space = useStorylineSpace(storylineId, { enabled: isOwner });

  const invalidate = () => utils.storyline.getById.invalidate({ id: storylineId });
  const update = trpc.storyline.update.useMutation({
    onSuccess: invalidate,
    onError: showError("Couldn't save that"),
  });
  const addCollaborator = trpc.storyline.addCollaborator.useMutation({
    onSuccess: invalidate,
    onError: showError("Couldn't endorse them"),
  });
  const removeCollaborator = trpc.storyline.removeCollaborator.useMutation({
    onSuccess: invalidate,
    onError: showError("Couldn't remove them"),
  });

  return (
    <Modal {...dialog} title={storyline?.title ?? 'Storyline'} size="lg">
      {isLoading ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : isError || !storyline ? (
        <Alert color="red">This storyline could not be loaded.</Alert>
      ) : !isOwner ? (
        <Alert color="gray">Only the storyline&apos;s creator can manage it.</Alert>
      ) : (
        <Tabs defaultValue="settings" keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="settings">Story settings</Tabs.Tab>
            <Tabs.Tab
              value="collaborators"
              rightSection={
                <Badge size="sm" variant="light" circle>
                  {storyline.collaborators.length}
                </Badge>
              }
            >
              Collaborators
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="settings">
            <StorylineSettingsForm
              status={storyline.status}
              maxNsfwLevel={storyline.maxNsfwLevel}
              space={space.data}
              disabled={update.isPending || space.isSaving}
              onStatusChange={(status) => update.mutate({ id: storylineId, status })}
              onRatingChange={(maxNsfwLevel) => update.mutate({ id: storylineId, maxNsfwLevel })}
              onSpaceChange={space.save}
            />
            {space.unavailable && (
              <Text size="xs" c="dimmed" mt="sm">
                Who can continue and the price are not available yet.
              </Text>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="collaborators">
            <StorylineCollaboratorsPanel
              ownerId={storyline.userId}
              collaborators={storyline.collaborators}
              canManage
              adding={addCollaborator.isPending}
              removingId={
                removeCollaborator.isPending ? removeCollaborator.variables?.userId : undefined
              }
              onAdd={(user) => addCollaborator.mutate({ storylineId, userId: user.id })}
              onRemove={(userId) => removeCollaborator.mutate({ storylineId, userId })}
            />
          </Tabs.Panel>

          <Group justify="space-between" mt="lg">
            <Button component="a" href={STORYLINE_QUEUE_RECEIVED_URL} variant="light">
              Review continuations
            </Button>
            <Button variant="default" onClick={dialog.onClose}>
              Done
            </Button>
          </Group>
        </Tabs>
      )}
    </Modal>
  );
}
