import {
  Alert,
  Button,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import {
  browsingLevelLabels,
  getHighestBrowsingLevelBit,
} from '~/shared/constants/browsingLevel.constants';
import { NsfwLevel } from '~/server/common/enums';
import { STORYLINE_CEILING_LEVELS } from '~/shared/utils/storyline';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** The lowest ceiling chapter 1 fits under; a ceiling below it would hide the story's own start. */
export function lowestCeilingFor(postNsfwLevel: number) {
  const highest = getHighestBrowsingLevelBit(postNsfwLevel);
  return (STORYLINE_CEILING_LEVELS as readonly number[]).includes(highest) ? highest : null;
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
  const minimum = lowestCeilingFor(postNsfwLevel);
  const [title, setTitle] = useState(postTitle ?? '');
  const [maxNsfwLevel, setMaxNsfwLevel] = useState<number>(
    Math.max(minimum ?? NsfwLevel.PG13, NsfwLevel.PG13)
  );

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
        {minimum == null ? (
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
              <SegmentedControl
                value={String(maxNsfwLevel)}
                onChange={(value) => setMaxNsfwLevel(Number(value))}
                data={STORYLINE_CEILING_LEVELS.map((level) => ({
                  value: String(level),
                  label: browsingLevelLabels[level],
                  disabled: level < minimum,
                }))}
              />
              <Text size="xs" c="dimmed">
                Continuations rated above this can&apos;t be added. It can&apos;t be lower than
                chapter 1&apos;s rating.
              </Text>
            </Stack>
            <Stack gap={2}>
              <Text size="sm" fw={500}>
                Continuing
              </Text>
              <Text size="sm">Anyone can continue, and you review each one. Free to continue.</Text>
              <Text size="xs" c="dimmed">
                You can change who can continue and the price in the storyline&apos;s settings.
              </Text>
            </Stack>
          </>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button
            disabled={minimum == null || !trimmed}
            loading={create.isPending}
            onClick={() => create.mutate({ postId, title: trimmed, maxNsfwLevel })}
          >
            Start storyline
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
