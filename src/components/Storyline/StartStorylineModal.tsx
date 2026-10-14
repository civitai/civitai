import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { StorylineContinueModeInput } from '~/components/Storyline/settings/StorylineContinueModeInput';
import { StorylineRatingInput } from '~/components/Storyline/settings/StorylineRatingInput';
import type { StorylineWhoCanContinue } from '~/components/Storyline/storyline-ui';
import type { StorylineSourcePost } from '~/components/Storyline/storyline.utils';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import { NsfwLevel } from '~/server/common/enums';
import { STORYLINE_CEILING_LEVELS, storylineLevelAllowed } from '~/shared/utils/storyline';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function openStartStorylineModal(post: StorylineSourcePost) {
  dialogStore.trigger({
    component: StartStorylineModal,
    props: { postId: post.id, postTitle: post.title, postNsfwLevel: post.nsfwLevel },
  });
}

export function StartStorylineModal({
  postId,
  postTitle,
  postNsfwLevel,
}: {
  postId: number;
  postTitle?: string | null;
  postNsfwLevel: number;
}) {
  const dialog = useDialogContext();
  const router = useRouter();
  const utils = trpc.useUtils();
  // The server's own rule, so a ceiling it would refuse is never offered: chapter 1 above its
  // storyline's ceiling would hide the story's start.
  const allowed = STORYLINE_CEILING_LEVELS.filter((level) =>
    storylineLevelAllowed({ postLevel: postNsfwLevel, maxNsfwLevel: level })
  );
  const canStart = allowed.length > 0;
  const [title, setTitle] = useState(postTitle ?? '');
  const [maxNsfwLevel, setMaxNsfwLevel] = useState<number>(
    allowed.find((level) => level >= NsfwLevel.PG13) ?? allowed[0] ?? NsfwLevel.PG13
  );
  const [whoCanContinue, setWhoCanContinue] = useState<StorylineWhoCanContinue>('Anyone');

  const create = trpc.storyline.create.useMutation({
    onSuccess: async ({ id }) => {
      await utils.storyline.getForPosts.invalidate();
      dialog.onClose();
      await router.push(storylineUrl(id));
    },
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't start the storyline",
        error: new Error(error.message),
      }),
  });

  const trimmed = title.trim();

  return (
    <Modal {...dialog} title="Start a storyline" size="md">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          This post becomes chapter 1. Its first image is the storyline&apos;s cover.
        </Text>
        {!canStart ? (
          <Alert color="yellow" icon={<IconAlertTriangle />}>
            This post hasn&apos;t been rated yet. Try again once its images have been scanned.
          </Alert>
        ) : (
          <>
            <TextInput
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              maxLength={255}
              required
            />
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Max rating
              </Text>
              <StorylineRatingInput
                value={maxNsfwLevel}
                onChange={setMaxNsfwLevel}
                isAllowed={(level) => allowed.includes(level)}
              />
              <Text size="xs" c="dimmed">
                Continuations rated above this can&apos;t be added. It can&apos;t be lower than
                chapter 1&apos;s rating.
              </Text>
            </Stack>
            <Stack gap={2}>
              <Text size="sm" fw={500}>
                Who can continue
              </Text>
              <StorylineContinueModeInput value={whoCanContinue} onChange={setWhoCanContinue} />
              <Text size="xs" c="dimmed">
                Free to continue. You can set a price from Manage on the storyline&apos;s page.
              </Text>
            </Stack>
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canStart || !trimmed}
            loading={create.isPending}
            onClick={() => create.mutate({ postId, title: trimmed, maxNsfwLevel, whoCanContinue })}
          >
            Start storyline
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
