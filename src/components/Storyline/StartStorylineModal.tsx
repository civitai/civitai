import { Alert, Button, Drawer, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { StorylineContinueModeInput } from '~/components/Storyline/settings/StorylineContinueModeInput';
import { StorylineRatingInput } from '~/components/Storyline/settings/StorylineRatingInput';
import {
  StorylineClosedChip,
  StorylineOpenToAnyoneChip,
  StorylinePriceChip,
} from '~/components/Storyline/StorylineChips';
import { storylineUrl, storylineWriteChapterUrl } from '~/components/Storyline/storyline-routes';
import type { StorylineWhoCanContinue } from '~/components/Storyline/storyline-ui';
import type { StorylineSourcePost } from '~/components/Storyline/storyline.utils';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NsfwLevel } from '~/server/common/enums';
import { STORYLINE_CEILING_LEVELS, storylineLevelAllowed } from '~/shared/utils/storyline';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function openStartStorylineModal(post?: StorylineSourcePost) {
  dialogStore.trigger({ component: StartStorylineModal, props: { post } });
}

/**
 * Starts a storyline. Without `post` it starts empty and hands the author to the post editor to
 * write chapter 1; with one, that published post is chapter 1. A bottom sheet on a phone.
 */
export function StartStorylineModal({ post }: { post?: StorylineSourcePost }) {
  const dialog = useDialogContext();
  const router = useRouter();
  const utils = trpc.useUtils();
  const mobile = useIsMobile({ type: 'media' });
  // Chapter 1 is already rated, so only the ceilings it fits are offered.
  const allowed = post
    ? STORYLINE_CEILING_LEVELS.filter((level) =>
        storylineLevelAllowed({ postLevel: post.nsfwLevel, maxNsfwLevel: level })
      )
    : STORYLINE_CEILING_LEVELS;
  const canStart = allowed.length > 0;
  const [title, setTitle] = useState(post?.title ?? '');
  const [maxNsfwLevel, setMaxNsfwLevel] = useState<number>(
    allowed.find((level) => level >= NsfwLevel.PG13) ?? allowed[0] ?? NsfwLevel.PG13
  );
  const [whoCanContinue, setWhoCanContinue] = useState<StorylineWhoCanContinue>('Anyone');

  const create = trpc.storyline.create.useMutation({
    onSuccess: async ({ id }) => {
      await Promise.all([
        utils.storyline.getInfinite.invalidate(),
        post && utils.storyline.getForPosts.invalidate(),
      ]);
      dialog.onClose();
      await router.push(post ? storylineUrl(id) : storylineWriteChapterUrl(id));
    },
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't start the storyline",
        error: new Error(error.message),
      }),
  });

  const trimmed = title.trim();

  const form = !canStart ? (
    <Alert color="yellow" icon={<IconAlertTriangle />}>
      This post hasn&apos;t been rated yet. Try again once its images have been scanned.
    </Alert>
  ) : (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        {post
          ? 'This post becomes chapter 1. Name the storyline and set the terms.'
          : "Name it and set the terms, then you'll write chapter 1 as a post."}
      </Text>
      <TextInput
        label="Title"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        maxLength={255}
        required
        data-autofocus
      />
      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Max rating
        </Text>
        <StorylineRatingInput
          value={maxNsfwLevel}
          onChange={setMaxNsfwLevel}
          isAllowed={post ? (level) => allowed.includes(level) : undefined}
        />
        <Text size="xs" c="dimmed">
          {post
            ? "Continuations rated above this can't be added. It can't be lower than chapter 1's rating."
            : "Continuations rated above this can't be added. If chapter 1 needs a higher rating, the maximum is raised to fit it."}
        </Text>
      </Stack>
      <Stack gap={2}>
        <Text size="sm" fw={500}>
          Who can continue
        </Text>
        <StorylineContinueModeInput value={whoCanContinue} onChange={setWhoCanContinue} />
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="storyline-start-terms">
          <StorylinePriceChip price={0} />
          {whoCanContinue === 'Anyone' ? (
            <StorylineOpenToAnyoneChip />
          ) : (
            <StorylineClosedChip label="Collaborators only" />
          )}
        </div>
        <Text size="xs" c="dimmed">
          You can set a price from Manage on the storyline&apos;s page.
        </Text>
      </Stack>
      <Group justify="flex-end">
        <Button variant="default" onClick={dialog.onClose}>
          Cancel
        </Button>
        <Button
          disabled={!trimmed}
          loading={create.isPending}
          onClick={() =>
            create.mutate({ postId: post?.id, title: trimmed, maxNsfwLevel, whoCanContinue })
          }
        >
          Start storyline
        </Button>
      </Group>
    </Stack>
  );

  return mobile ? (
    <Drawer {...dialog} position="bottom" title="Start a storyline" size="32rem" radius="lg">
      {form}
    </Drawer>
  ) : (
    <Modal {...dialog} title="Start a storyline" size="md">
      {form}
    </Modal>
  );
}
