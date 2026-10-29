import { Alert, Group, Loader, Modal, SegmentedControl } from '@mantine/core';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  StorylineContinueForm,
  type StorylineSubmitOutcome,
} from '~/components/Storyline/continue/StorylineContinueForm';
import { StorylineJoinChapterForm } from '~/components/Storyline/continue/StorylineJoinChapterForm';
import { storylineSubmitInput } from '~/components/Storyline/storyline-ui';
import { getStorylineChapterName } from '~/components/Storyline/storyline-mode.utils';
import {
  useAddOwnerStorylineChapter,
  useOwnStorylinePosts,
  useInsertStorylineChapter,
  useStorylineContinueTerms,
  useSubmitStorylineContinuation,
} from '~/components/Storyline/storyline.data';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export type StorylineContinueModalProps = {
  parentPostId: number;
  /** The contributor's post, when they started from it. */
  postId?: number;
  /**
   * The chapter that ends here, set by the end-of-chapter screen. Used only when the viewer owns
   * the storyline, who adds the chapter directly instead of submitting it for review.
   */
  parentChapterId?: number;
  /**
   * Set by the map's "Insert here": the owner's post goes between `parentChapterId` and this
   * chapter instead of after the parent.
   */
  insertBeforeChapterId?: number;
  /** Which way the owner's picker opens; they can switch. */
  mode?: 'post' | 'join';
};

export default function StorylineContinueModal({
  parentPostId,
  postId: initialPostId,
  parentChapterId,
  insertBeforeChapterId,
  mode: initialMode = 'post',
}: StorylineContinueModalProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const enabled = !!currentUser && !!features.storylines;
  const [postId, setPostId] = useState<number | null>(initialPostId ?? null);
  const [outcome, setOutcome] = useState<StorylineSubmitOutcome | null>(null);
  const [mode, setMode] = useState<'post' | 'join'>(initialMode);

  const { data: membership, isLoading: membershipLoading } = trpc.storyline.getForPosts.useQuery(
    { postIds: [parentPostId] },
    { enabled }
  );
  const parentChapter = membership?.[parentPostId];
  const storylineId = parentChapter?.storylineId;
  const { data: storyline, isLoading: storylineLoading } = trpc.storyline.getById.useQuery(
    { id: storylineId ?? 0 },
    { enabled: !!storylineId }
  );
  const { data: parentPost } = trpc.post.get.useQuery({ id: parentPostId }, { enabled });
  const terms = useStorylineContinueTerms(parentPostId, { enabled });
  const submit = useSubmitStorylineContinuation({ onSuccess: setOutcome });
  const addOwn = useAddOwnerStorylineChapter({ onSuccess: () => setOutcome('added') });
  const insert = useInsertStorylineChapter({ onSuccess: () => setOutcome('added') });
  const inserting = insertBeforeChapterId !== undefined;
  const isOwner = !!currentUser && !!storyline && storyline.userId === currentUser.id;
  // A moderator inserts and joins for the owner; continuing as themselves stays theirs.
  const managing = isOwner || (!!storyline && !!currentUser?.isModerator);
  const ownerAdd = !!parentChapterId && (isOwner || (managing && inserting));
  const actingAsOwner = ownerAdd && !isOwner;
  const joining = managing && !!parentChapterId && mode === 'join';

  const { posts, alreadyChapters, postsLoading, postsError, morePosts } = useOwnStorylinePosts({
    enabled: enabled && !!storyline,
    excludePostId: parentPostId,
    author: actingAsOwner && storyline ? storyline.user : undefined,
  });

  const parentName =
    parentChapter && parentPost
      ? getStorylineChapterName({
          depth: parentChapter.depth,
          tombstone: null,
          post: {
            id: parentPost.id,
            title: parentPost.title,
            userId: parentPost.user.id,
            username: parentPost.user.username,
          },
        })
      : null;

  const ownerPending = inserting ? insert.isPending : addOwn.isPending;
  const ownerError = inserting ? insert.error : addOwn.error;

  const loading = membershipLoading || storylineLoading || terms.isLoading;

  return (
    <Modal
      {...dialog}
      title={
        inserting ? 'Insert a chapter' : ownerAdd ? 'Add the next chapter' : 'Continue the story'
      }
      size="md"
    >
      {!currentUser ? (
        <Alert color="gray">Sign in to continue a storyline.</Alert>
      ) : !features.storylines ? (
        <Alert color="gray">Storylines are not available yet.</Alert>
      ) : loading ? (
        <Group justify="center" p="xl">
          <Loader />
        </Group>
      ) : !storylineId || !storyline ? (
        <Alert color="gray">This chapter is not part of a storyline you can continue.</Alert>
      ) : !ownerAdd && !joining && terms.unavailable ? (
        <Alert color="gray">Continuing storylines is not open yet.</Alert>
      ) : !ownerAdd && !joining && !terms.data ? (
        <Alert color="red">Couldn&apos;t load what continuing this storyline costs.</Alert>
      ) : (
        <>
          {ownerAdd && parentChapterId && !inserting && (
            <SegmentedControl
              fullWidth
              mb="md"
              value={mode}
              onChange={(value) => setMode(value as typeof mode)}
              data={[
                { value: 'post', label: 'Use a post you made' },
                { value: 'join', label: 'Join an existing chapter' },
              ]}
              data-testid="storyline-add-mode"
            />
          )}
          {joining && parentChapterId ? (
            <StorylineJoinChapterForm
              parentChapterId={parentChapterId}
              parentName={parentName}
              onClose={dialog.onClose}
            />
          ) : (
            <StorylineContinueForm
              viewerId={actingAsOwner ? storyline.userId : currentUser.id}
              storyline={storyline}
              cover={storyline.coverImage}
              parentName={parentName}
              closedReason={terms.data?.closedReason ?? null}
              price={terms.data?.price ?? 0}
              ownerAdd={ownerAdd}
              inserting={inserting}
              isCollaborator={storyline.collaborators.some((user) => user.id === currentUser.id)}
              posts={posts}
              postsLoading={postsLoading}
              alreadyChapters={alreadyChapters}
              postsError={postsError}
              morePosts={morePosts}
              postId={postId}
              onPostChange={setPostId}
              submitting={ownerAdd ? ownerPending : submit.isPending}
              error={ownerAdd ? ownerError : submit.error}
              outcome={outcome}
              onLeave={dialog.onClose}
              onSubmit={() => {
                const post = posts.find((candidate) => candidate.id === postId);
                if (ownerAdd && parentChapterId) {
                  if (!post) return;
                  if (insertBeforeChapterId !== undefined)
                    insert.mutate({
                      storylineId: storyline.id,
                      parentChapterId,
                      childChapterId: insertBeforeChapterId,
                      postId: post.id,
                    });
                  else addOwn.mutate({ parentChapterId, postId: post.id });
                  return;
                }
                if (!post || !terms.data) return;
                submit.mutate(
                  storylineSubmitInput({ parentPostId, post, shownPrice: terms.data.price })
                );
              }}
            />
          )}
        </>
      )}
    </Modal>
  );
}
