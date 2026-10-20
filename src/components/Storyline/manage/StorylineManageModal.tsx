import { Alert, Badge, Button, Group, Loader, Modal, Tabs, Text } from '@mantine/core';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { STORYLINE_QUEUE_RECEIVED_URL } from '~/components/Placement/queue-routes';
import { StorylineCollaboratorsPanel } from '~/components/Storyline/manage/StorylineCollaboratorsPanel';
import { StorylineCoversRow } from '~/components/Storyline/manage/StorylineCoversRow';
import { StorylineSettingsForm } from '~/components/Storyline/manage/StorylineSettingsForm';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import {
  useStorylineChapterLevels,
  useStorylineSpace,
} from '~/components/Storyline/storyline.data';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const showError = (title: string) => (error: { message: string }) =>
  showErrorNotification({ title, error: new Error(error.message) });

export default function StorylineManageModal({ storylineId }: { storylineId: number }) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const utils = trpc.useUtils();

  const {
    data: storyline,
    isLoading,
    isError,
  } = trpc.storyline.getById.useQuery({ id: storylineId }, { enabled: !!features.storylines });
  const isOwner = !!currentUser && storyline?.userId === currentUser.id;
  const space = useStorylineSpace(storylineId, { enabled: isOwner });
  const chapterLevels = useStorylineChapterLevels(storylineId, { enabled: isOwner });

  const invalidate = () => utils.storyline.getById.invalidate({ id: storylineId });
  const update = trpc.storyline.update.useMutation({
    onSuccess: () =>
      Promise.all([invalidate(), utils.placement.getStorylineSpace.invalidate({ storylineId })]),
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
    <Modal
      {...dialog}
      title={
        <Group gap="sm" wrap="nowrap">
          {storyline && <StorylineThumb image={storyline.coverImage} width={24} />}
          <Text component="span" fw={600} lineClamp={1}>
            <Text component="span" c="dimmed" inherit>
              Manage
            </Text>{' '}
            {storyline?.title ?? 'storyline'}
          </Text>
        </Group>
      }
      size="lg"
    >
      {!features.storylines ? (
        <Alert color="gray">Storylines are not available yet.</Alert>
      ) : isLoading ? (
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
                storyline.collaborators.length ? (
                  <Badge size="sm" variant="light" radius="xl">
                    {storyline.collaborators.length}
                  </Badge>
                ) : null
              }
            >
              Collaborators
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="settings">
            <StorylineSettingsForm
              coverRow={<StorylineCoversRow storylineId={storylineId} />}
              status={storyline.status}
              maxNsfwLevel={storyline.ownerMaxNsfwLevel ?? storyline.maxNsfwLevel}
              whoCanContinue={storyline.whoCanContinue}
              space={space.data}
              chapterLevels={chapterLevels}
              disabled={update.isPending || space.isSaving}
              onStatusChange={(status) => update.mutate({ id: storylineId, status })}
              onRatingChange={(maxNsfwLevel) => update.mutate({ id: storylineId, maxNsfwLevel })}
              onWhoCanContinueChange={(whoCanContinue) =>
                update.mutate({ id: storylineId, whoCanContinue })
              }
              onPriceChange={space.save}
              priceUnavailable={space.unavailable}
            />
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
