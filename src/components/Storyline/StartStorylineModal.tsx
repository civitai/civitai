import { Alert, Button, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useQueryImages } from '~/components/Image/image.utils';
import { StorylineContinueModeInput } from '~/components/Storyline/settings/StorylineContinueModeInput';
import {
  StorylineClosedChip,
  StorylineOpenToAnyoneChip,
  StorylinePriceChip,
} from '~/components/Storyline/StorylineChips';
import { StorylineThumb, type StorylineThumbImage } from '~/components/Storyline/StorylineThumb';
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
  const allowed = STORYLINE_CEILING_LEVELS.filter((level) =>
    storylineLevelAllowed({ postLevel: postNsfwLevel, maxNsfwLevel: level })
  );
  const canStart = allowed.length > 0;
  const [title, setTitle] = useState(postTitle ?? '');
  const [maxNsfwLevel, setMaxNsfwLevel] = useState<number>(
    allowed.find((level) => level >= NsfwLevel.PG13) ?? allowed[0] ?? NsfwLevel.PG13
  );
  const [whoCanContinue, setWhoCanContinue] = useState<StorylineWhoCanContinue>('Anyone');
  // No storyline exists yet to carry a cover, so the post's first image is read as the page would.
  const { images, isLoading: coverLoading } = useQueryImages(
    { postId, limit: 1, withMeta: false, include: [] },
    { enabled: canStart }
  );
  const cover = coverLoading ? undefined : (images[0] as StorylineThumbImage | undefined) ?? null;

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
            <div className="flex items-start gap-3.5">
              <figure className="m-0 w-[120px] shrink-0" data-testid="storyline-start-cover">
                <StorylineThumb
                  image={cover}
                  width={120}
                  ratio="4/5"
                  fluid
                  className="rounded-lg"
                />
                <Text component="figcaption" size="xs" c="dimmed" mt={4} lh={1.3}>
                  Chapter 1 and the cover
                </Text>
              </figure>
              <TextInput
                label="Title"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                maxLength={255}
                required
                className="min-w-0 flex-1"
              />
            </div>
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
