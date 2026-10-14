import { Alert, Group, Loader, Modal } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  StorylineContinueForm,
  type StorylineSubmitOutcome,
} from '~/components/Storyline/continue/StorylineContinueForm';
import {
  useStorylineContinueTerms,
  useSubmitStorylineContinuation,
} from '~/components/Storyline/storyline.data';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { trpc } from '~/utils/trpc';

export type StorylineContinueModalProps = {
  /** The chapter post being continued. */
  parentPostId: number;
  /** The contributor's post, when they started from it. */
  postId?: number;
};

/** Submit one of your posts as a continuation of someone's storyline chapter. */
export default function StorylineContinueModal({
  parentPostId,
  postId: initialPostId,
}: StorylineContinueModalProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const [postId, setPostId] = useState<number | null>(initialPostId ?? null);
  const [outcome, setOutcome] = useState<StorylineSubmitOutcome | null>(null);

  const { data: membership, isLoading: membershipLoading } = trpc.storyline.getForPosts.useQuery({
    postIds: [parentPostId],
  });
  const storylineId = membership?.[parentPostId]?.storylineId;
  const { data: storyline, isLoading: storylineLoading } = trpc.storyline.getById.useQuery(
    { id: storylineId ?? 0 },
    { enabled: !!storylineId }
  );
  // Every level: a post above the storyline's ceiling has to be listed to be refused out loud.
  const { data: postPages, isLoading: postsLoading } = trpc.post.getInfinite.useInfiniteQuery(
    {
      username: currentUser?.username,
      browsingLevel: allBrowsingLevelsFlag,
      limit: 50,
    },
    { enabled: !!currentUser?.username, getNextPageParam: (page) => page.nextCursor }
  );
  const { data: parentPost } = trpc.post.get.useQuery({ id: parentPostId });
  const terms = useStorylineContinueTerms(storylineId ?? null);
  const submit = useSubmitStorylineContinuation({ onSuccess: setOutcome });

  const posts = (postPages?.pages.flatMap((page) => page.items) ?? [])
    .filter((post) => post.id !== parentPostId)
    .map((post) => ({ id: post.id, title: post.title, nsfwLevel: post.nsfwLevel }));

  const loading = membershipLoading || storylineLoading || postsLoading || terms.isLoading;

  return (
    <Modal {...dialog} title="Continue the story" size="md">
      {!currentUser ? (
        <Alert color="gray">Sign in to continue a storyline.</Alert>
      ) : loading ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : !storylineId || !storyline ? (
        <Alert color="gray">This chapter is not part of a storyline you can continue.</Alert>
      ) : !terms.data || submit.unavailable ? (
        <Alert color="gray">Continuing storylines is not open yet.</Alert>
      ) : (
        <StorylineContinueForm
          viewerId={currentUser.id}
          storyline={storyline}
          parentTitle={parentPost?.title ?? null}
          mode={terms.data.mode}
          price={terms.data.price}
          isCollaborator={storyline.collaborators.some((user) => user.id === currentUser.id)}
          posts={posts}
          postId={postId}
          onPostChange={setPostId}
          submitting={submit.isPending}
          error={submit.error}
          outcome={outcome}
          onSubmit={() =>
            postId && submit.mutate({ parentPostId, postId, expectedPrice: terms.data?.price ?? 0 })
          }
        />
      )}
    </Modal>
  );
}
