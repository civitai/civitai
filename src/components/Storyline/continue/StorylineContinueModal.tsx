import { Alert, Group, Loader, Modal, SegmentedControl } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  StorylineContinueForm,
  type StorylineSubmitOutcome,
} from '~/components/Storyline/continue/StorylineContinueForm';
import { StorylineJoinChapterForm } from '~/components/Storyline/continue/StorylineJoinChapterForm';
import {
  STORYLINE_CONTINUE_POST_LIMIT,
  storylineContinuePostOptions,
  storylineWithoutChapters,
  storylineSubmitInput,
} from '~/components/Storyline/storyline-ui';
import { getStorylineChapterName } from '~/components/Storyline/storyline-mode.utils';
import {
  useAddOwnerStorylineChapter,
  useStorylineContinueTerms,
  useSubmitStorylineContinuation,
} from '~/components/Storyline/storyline.data';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PostSort } from '~/server/common/enums';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
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
  /** Which way the owner's picker opens; they can switch. */
  mode?: 'post' | 'join';
};

export default function StorylineContinueModal({
  parentPostId,
  postId: initialPostId,
  parentChapterId,
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
  // Every level: a post above the storyline's ceiling has to be listed to be refused out loud.
  // Newest, all time: the default sort lists only posts that already have reactions, which leaves
  // out the post just made to continue the story.
  const {
    data: postPages,
    isLoading: postsLoading,
    isError: postsError,
  } = trpc.post.getInfinite.useInfiniteQuery(
    {
      username: currentUser?.username,
      browsingLevel: allBrowsingLevelsFlag,
      limit: STORYLINE_CONTINUE_POST_LIMIT,
      sort: PostSort.Newest,
      period: MetricTimeframe.AllTime,
    },
    { enabled: enabled && !!currentUser?.username, getNextPageParam: (page) => page.nextCursor }
  );
  const { data: parentPost } = trpc.post.get.useQuery({ id: parentPostId }, { enabled });
  const terms = useStorylineContinueTerms(parentPostId, { enabled });
  const submit = useSubmitStorylineContinuation({ onSuccess: setOutcome });
  const addOwn = useAddOwnerStorylineChapter({ onSuccess: () => setOutcome('added') });
  const ownerAdd =
    !!currentUser && !!storyline && !!parentChapterId && storyline.userId === currentUser.id;

  const firstPage = postPages?.pages[0];
  const ownPosts = useMemo(
    () =>
      currentUser
        ? storylineContinuePostOptions(firstPage?.items ?? [], {
            viewerId: currentUser.id,
            parentPostId,
          })
        : [],
    [currentUser, firstPage, parentPostId]
  );
  // Which of them are already chapters; the author is told whatever the post's level.
  const ownPostIds = useMemo(() => ownPosts.map((post) => post.id), [ownPosts]);
  const { data: ownChapters, isLoading: ownChaptersLoading } = trpc.storyline.getForPosts.useQuery(
    { postIds: ownPostIds, browsingLevel: allBrowsingLevelsFlag },
    // Keep the last answer while a refetch adds a post, so the grid does not blink to skeletons.
    { enabled: enabled && ownPostIds.length > 0, placeholderData: (previous) => previous }
  );
  const { posts, alreadyChapters } = storylineWithoutChapters(
    ownPosts,
    new Set(Object.keys(ownChapters ?? {}).map(Number))
  );

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

  const loading = membershipLoading || storylineLoading || terms.isLoading;

  return (
    <Modal {...dialog} title={ownerAdd ? 'Add the next chapter' : 'Continue the story'} size="md">
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
      ) : !ownerAdd && terms.unavailable ? (
        <Alert color="gray">Continuing storylines is not open yet.</Alert>
      ) : !ownerAdd && !terms.data ? (
        <Alert color="red">Couldn&apos;t load what continuing this storyline costs.</Alert>
      ) : (
        <>
          {ownerAdd && parentChapterId && (
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
          {ownerAdd && parentChapterId && mode === 'join' ? (
            <StorylineJoinChapterForm
              parentChapterId={parentChapterId}
              parentName={parentName}
              onClose={dialog.onClose}
            />
          ) : (
            <StorylineContinueForm
              viewerId={currentUser.id}
              storyline={storyline}
              cover={storyline.coverImage}
              parentName={parentName}
              closedReason={terms.data?.closedReason ?? null}
              price={terms.data?.price ?? 0}
              ownerAdd={ownerAdd}
              isCollaborator={storyline.collaborators.some((user) => user.id === currentUser.id)}
              posts={posts}
              postsLoading={postsLoading || (ownPostIds.length > 0 && ownChaptersLoading)}
              alreadyChapters={alreadyChapters}
              // A failed refetch keeps the posts already shown.
              postsError={postsError && !firstPage}
              morePosts={!!firstPage?.nextCursor}
              postId={postId}
              onPostChange={setPostId}
              submitting={ownerAdd ? addOwn.isPending : submit.isPending}
              error={ownerAdd ? addOwn.error : submit.error}
              outcome={outcome}
              onLeave={dialog.onClose}
              onSubmit={() => {
                const post = posts.find((candidate) => candidate.id === postId);
                if (ownerAdd && parentChapterId) {
                  if (post) addOwn.mutate({ parentChapterId, postId: post.id });
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
