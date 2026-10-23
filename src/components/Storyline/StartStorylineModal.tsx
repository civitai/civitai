import { Button, Drawer, Group, Modal, Stack, Text, TextInput } from '@mantine/core';
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
import { storylineWriteChapterUrl } from '~/components/Storyline/storyline-routes';
import type { StorylineWhoCanContinue } from '~/components/Storyline/storyline-ui';
import { useIsMobile } from '~/hooks/useIsMobile';
import { NsfwLevel } from '~/server/common/enums';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function openStartStorylineModal() {
  dialogStore.trigger({ component: StartStorylineModal });
}

/**
 * Starts an empty storyline, then hands the author to the post editor to write chapter 1. A bottom
 * sheet on a phone.
 */
export function StartStorylineModal() {
  const dialog = useDialogContext();
  const router = useRouter();
  const utils = trpc.useUtils();
  const mobile = useIsMobile({ type: 'media' });
  const [title, setTitle] = useState('');
  const [maxNsfwLevel, setMaxNsfwLevel] = useState<number>(NsfwLevel.PG13);
  const [whoCanContinue, setWhoCanContinue] = useState<StorylineWhoCanContinue>('Anyone');

  const create = trpc.storyline.create.useMutation({
    onSuccess: async ({ id }) => {
      await utils.storyline.getInfinite.invalidate();
      dialog.onClose();
      await router.push(storylineWriteChapterUrl(id));
    },
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't start the storyline",
        error: new Error(error.message),
      }),
  });

  const trimmed = title.trim();

  const form = (
    <Stack gap="md">
      <Text size="sm" c="dimmed">
        Name it and set the terms, then you&apos;ll write chapter 1 as a post.
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
        <StorylineRatingInput value={maxNsfwLevel} onChange={setMaxNsfwLevel} />
        <Text size="xs" c="dimmed">
          Continuations rated above this can&apos;t be added. If chapter 1 needs a higher rating,
          the maximum is raised to fit it.
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
          onClick={() => create.mutate({ title: trimmed, maxNsfwLevel, whoCanContinue })}
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
