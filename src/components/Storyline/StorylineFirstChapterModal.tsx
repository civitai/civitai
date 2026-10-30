import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { StorylinePostPicker } from '~/components/Storyline/continue/StorylinePostPicker';
import { useOwnStorylinePosts } from '~/components/Storyline/storyline.data';
import { storylineUrl } from '~/components/Storyline/storyline-routes';
import {
  getBrowsingLevelLabel,
  getHighestBrowsingLevelBit,
} from '~/shared/constants/browsingLevel.constants';
import { storylineLevelAllowed } from '~/shared/utils/storyline';
import { isStorylineVerdictLevel, STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export type StorylineFirstChapterModalProps = { storylineId: number };

/** The owner of an empty storyline picks a post they have already published as its chapter 1. */
export default function StorylineFirstChapterModal({
  storylineId,
}: StorylineFirstChapterModalProps) {
  const dialog = useDialogContext();
  const router = useRouter();
  const utils = trpc.useUtils();
  const [postId, setPostId] = useState<number | null>(null);
  const { data: storyline, isLoading } = trpc.storyline.getById.useQuery({ id: storylineId });
  // A scheduled post is refused until it goes live, so it is not offered.
  const own = useOwnStorylinePosts({ enabled: true, publishedOnly: true });
  const { posts } = own;
  const post = posts.find((candidate) => candidate.id === postId) ?? null;

  const setFirstChapter = trpc.storyline.setFirstChapter.useMutation({
    onSuccess: async ({ ceilingRaisedTo }) => {
      await utils.storyline.invalidate();
      dialog.onClose();
      showSuccessNotification({
        title: 'Chapter 1 is in',
        message: ceilingRaisedTo
          ? `The storyline's maximum rating was raised to ${getBrowsingLevelLabel(
              ceilingRaisedTo
            )} to fit it.`
          : 'Your post is now chapter 1 of the storyline.',
      });
      await router.push(storylineUrl(storylineId));
    },
  });

  const ceiling = storyline ? getBrowsingLevelLabel(storyline.maxNsfwLevel) : '';
  // Below the owner's own setting, a title held to safe for work caps it, and raising cannot help.
  const canRaise = storyline?.maxNsfwLevel === storyline?.ownerMaxNsfwLevel;
  const fits = (postLevel: number) =>
    !!storyline && storylineLevelAllowed({ postLevel, maxNsfwLevel: storyline.maxNsfwLevel });
  const isAboveCeiling = (postLevel: number) =>
    !!postLevel && !isStorylineVerdictLevel(postLevel) && !canRaise && !fits(postLevel);
  const unusable = !!post && isStorylineVerdictLevel(post.nsfwLevel);
  const raisesCeiling = !!post?.nsfwLevel && !unusable && canRaise && !fits(post.nsfwLevel);
  const aboveCeiling = !!post && isAboveCeiling(post.nsfwLevel);

  return (
    <Modal {...dialog} title="Use a post you've published" size="md">
      {isLoading ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : !storyline ? (
        <Alert color="gray">This storyline could not be loaded.</Alert>
      ) : (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            The post you pick becomes chapter 1 of {storyline.title}.
          </Text>
          <StorylinePostPicker
            posts={posts}
            postsLoading={own.postsLoading}
            postsError={own.postsError}
            alreadyChapters={own.alreadyChapters}
            allChaptersText="All your recent posts are already chapters."
            paging={own.paging}
            postId={postId}
            onPostChange={setPostId}
            ceiling={ceiling}
            isAboveCeiling={isAboveCeiling}
          />
          {post && !post.nsfwLevel && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              <Text size="sm">This post has not been rated yet. Try again once it has been.</Text>
            </Alert>
          )}
          {unusable && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              <Text size="sm">{STORYLINE_REFUSALS.cannotSubmit}.</Text>
            </Alert>
          )}
          {aboveCeiling && (
            <Alert color="red" icon={<IconAlertTriangle size={18} />}>
              <Text size="sm">
                This post is rated above this storyline&apos;s maximum of {ceiling}.
              </Text>
            </Alert>
          )}
          {post && raisesCeiling && (
            // Hedged: a ceiling held to safe for work cannot be raised, and the client is not told.
            <Text size="sm" c="dimmed">
              This post is rated {getBrowsingLevelLabel(getHighestBrowsingLevelBit(post.nsfwLevel))}
              , above this storyline&apos;s maximum of {ceiling}. Making it chapter 1 raises the
              maximum to fit it, where the storyline allows that.
            </Text>
          )}
          {setFirstChapter.error && (
            <Alert color="red">
              <Text size="sm">{setFirstChapter.error.message}</Text>
            </Alert>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={dialog.onClose}>
              Cancel
            </Button>
            <Button
              disabled={!post?.nsfwLevel || aboveCeiling || unusable}
              loading={setFirstChapter.isPending}
              onClick={() => post && setFirstChapter.mutate({ storylineId, postId: post.id })}
            >
              Make it chapter 1
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
