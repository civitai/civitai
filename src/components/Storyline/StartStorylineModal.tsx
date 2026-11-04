import { Alert, Button, Drawer, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { StorylineContinueModeInput } from '~/components/Storyline/settings/StorylineContinueModeInput';
import { StorylineRatingInput } from '~/components/Storyline/settings/StorylineRatingInput';
import { StorylineSparkCreditText } from '~/components/Storyline/StorylineSparkCredit';
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
import { isStorylineVerdictLevel, STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function openStartStorylineModal(post?: StorylineSourcePost) {
  dialogStore.trigger({ component: StartStorylineModal, props: { post } });
}

/** Someone's image a storyline starts from: credited above chapter 1, and its rating is the floor. */
export type StorylineSparkImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  username: string | null;
};

export function openStartStorylineFromImageModal(sparkImage: StorylineSparkImage) {
  dialogStore.trigger({ component: StartStorylineModal, props: { sparkImage } });
}

/**
 * Starts a storyline. Without `post` it starts empty and hands the author to the post editor to
 * write chapter 1; with one, that published post is chapter 1. With `sparkImage` it starts empty,
 * credited to that image. A bottom sheet on a phone.
 */
export function StartStorylineModal({
  post,
  sparkImage,
}: {
  post?: StorylineSourcePost;
  sparkImage?: StorylineSparkImage;
}) {
  const dialog = useDialogContext();
  const router = useRouter();
  const utils = trpc.useUtils();
  const mobile = useIsMobile({ type: 'media' });
  // Chapter 1 and the spark are already rated, so only the ceilings both fit are offered.
  const floors = [post?.nsfwLevel, sparkImage?.nsfwLevel].filter(
    (level): level is number => level !== undefined
  );
  const allowed = STORYLINE_CEILING_LEVELS.filter((level) =>
    floors.every((postLevel) => storylineLevelAllowed({ postLevel, maxNsfwLevel: level }))
  );
  const rated = post ?? sparkImage;
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

  const credit = sparkImage && (
    <div className="flex items-center gap-3" data-testid="storyline-spark-credit">
      <EdgeMedia
        src={sparkImage.url}
        type="image"
        width={96}
        className="size-12 shrink-0 rounded object-cover"
      />
      <StorylineSparkCreditText username={sparkImage.username} />
    </div>
  );

  const form = !canStart ? (
    floors.some(isStorylineVerdictLevel) ? (
      <Alert color="red" icon={<IconAlertTriangle />}>
        {STORYLINE_REFUSALS.cannotSubmit}.
      </Alert>
    ) : (
      <Alert color="yellow" icon={<IconAlertTriangle />}>
        {post
          ? "This post hasn't been rated yet. Try again once its images have been scanned."
          : "This image hasn't been rated yet. Try again once it has been scanned."}
      </Alert>
    )
  ) : (
    <Stack gap="md">
      {credit}
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
          isAllowed={rated ? (level) => allowed.includes(level) : undefined}
        />
        <Text size="xs" c="dimmed">
          {post
            ? "Continuations rated above this can't be added. It can't be lower than chapter 1's rating."
            : sparkImage
            ? "Continuations rated above this can't be added. It can't be lower than the image's rating."
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
            create.mutate({
              postId: post?.id,
              sparkImageId: sparkImage?.id,
              title: trimmed,
              maxNsfwLevel,
              whoCanContinue,
            })
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
