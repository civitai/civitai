import { Alert, Anchor, Badge, Button, Group, Stack, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconClock,
  IconShieldHalf,
} from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import {
  StorylinePostPicker,
  type StorylineContinuePost,
} from '~/components/Storyline/continue/StorylinePostPicker';
import { StorylineThumb, type StorylineThumbImage } from '~/components/Storyline/StorylineThumb';
import type { StorylinePostPaging } from '~/components/Storyline/storyline.data';
import { STORYLINE_QUEUE_SENT_URL } from '~/components/Placement/queue-routes';
import {
  STORYLINE_CONTINUATION_EXPIRY_DAYS,
  storylinePriceLabel,
  storylineSubmitVerdict,
  type StorylineClosedReason,
} from '~/components/Storyline/storyline-ui';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

export type StorylineSubmitOutcome = 'pending' | 'approved' | 'awaitingScan' | 'added';

const refusalCopy = {
  ownStoryline: 'This is your storyline. Add your next chapter from the storyline page instead.',
  complete: 'This storyline is complete and is not taking continuations.',
  collaboratorsOnly: 'Only the creator’s endorsed collaborators can continue this storyline.',
  closed: 'This storyline is not taking continuations right now.',
} as const;

export function StorylineContinueForm({
  viewerId,
  storyline,
  cover,
  parentName,
  closedReason,
  price,
  isCollaborator,
  posts,
  postsLoading,
  postsError,
  alreadyChapters = 0,
  paging,
  postId,
  onPostChange,
  onSubmit,
  onStartOwn,
  ownerAdd = false,
  inserting = false,
  branch = false,
  submitting,
  outcome,
  error,
  onLeave,
}: {
  viewerId: number;
  storyline: {
    title: string;
    userId: number;
    status: 'Ongoing' | 'Complete';
    maxNsfwLevel: number;
  };
  /** The storyline's card picture from its read; `null` when none may be shown. */
  cover?: StorylineThumbImage | null;
  parentName: string | null;
  /** From the server's read for this viewer; `null` when they may continue. */
  closedReason: StorylineClosedReason | null;
  price: number;
  isCollaborator: boolean;
  posts: StorylineContinuePost[];
  postsLoading?: boolean;
  postsError?: boolean;
  /** The viewer's posts left out because they are already chapters. */
  alreadyChapters?: number;
  paging?: StorylinePostPaging;
  postId: number | null;
  onPostChange: (postId: number | null) => void;
  onSubmit: () => void;
  onStartOwn?: () => void;
  /** The viewer owns the storyline: the post joins as the next chapter at once, unpriced. */
  ownerAdd?: boolean;
  /** The owner's post goes between two chapters, not after the last. */
  inserting?: boolean;
  /** The parent already has a main-path chapter: this starts a branch. */
  branch?: boolean;
  submitting?: boolean;
  outcome?: StorylineSubmitOutcome | null;
  error?: string | null;
  /** Called when a link takes the author elsewhere: the dialog does not close itself on navigation. */
  onLeave?: () => void;
}) {
  const post = posts.find((candidate) => candidate.id === postId) ?? null;
  const ceiling = getBrowsingLevelLabel(storyline.maxNsfwLevel);
  const verdict = storylineSubmitVerdict({
    postLevel: post?.nsfwLevel ?? 0,
    viewerId,
    storyline,
    closedReason,
    asOwner: ownerAdd,
  });

  // The same rule as the refusal below, so a tile is marked exactly when picking it would be refused.
  const isAboveCeiling = (postLevel: number) => {
    const tileVerdict = storylineSubmitVerdict({
      postLevel,
      viewerId,
      storyline,
      closedReason,
      asOwner: ownerAdd,
    });
    return !tileVerdict.allowed && tileVerdict.reason === 'aboveRating';
  };

  if (outcome)
    return (
      <StorylineSubmitted
        outcome={outcome}
        price={price}
        inserting={inserting}
        branch={branch}
        onLeave={onLeave}
      />
    );

  if (
    !verdict.allowed &&
    verdict.reason !== 'aboveRating' &&
    verdict.reason !== 'notRated' &&
    verdict.reason !== 'cannotSubmit'
  )
    return (
      <Alert color="gray" icon={<IconAlertTriangle size={18} />}>
        <Text size="sm">{refusalCopy[verdict.reason]}</Text>
      </Alert>
    );

  return (
    <Stack gap="md">
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <StorylineThumb image={cover} width={48} className="shrink-0" />
        <Stack gap={6} className="min-w-0">
          <div>
            <Text fw={600} lineClamp={2}>
              {branch
                ? `Start a branch in ${storyline.title}`
                : ownerAdd
                ? `Add the next chapter to ${storyline.title}`
                : `Continue ${storyline.title}`}
            </Text>
            {parentName && (
              <Text size="sm" c="dimmed" lineClamp={1}>
                after {parentName}
              </Text>
            )}
          </div>
          <Group gap={6}>
            <Badge
              variant="light"
              color="gray"
              size="sm"
              radius="xl"
              leftSection={<IconShieldHalf size={12} />}
            >
              Up to {ceiling}
            </Badge>
            {ownerAdd ? null : price > 0 ? (
              <Badge
                variant="light"
                color="yellow"
                size="sm"
                radius="xl"
                leftSection={<IconBolt size={12} />}
              >
                {storylinePriceLabel(price)} to continue
              </Badge>
            ) : (
              <Badge variant="light" color="green" size="sm" radius="xl">
                Free to continue
              </Badge>
            )}
          </Group>
        </Stack>
      </Group>

      <StorylinePostPicker
        posts={posts}
        postsLoading={postsLoading}
        postsError={postsError}
        alreadyChapters={alreadyChapters}
        allChaptersText="All your recent posts are already chapters. Make a new post to continue the story."
        paging={paging}
        postId={postId}
        onPostChange={onPostChange}
        ceiling={ceiling}
        isAboveCeiling={isAboveCeiling}
      />

      {post && !verdict.allowed && verdict.reason === 'notRated' && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          <Text size="sm">This post has not been rated yet. Try again once it has been.</Text>
        </Alert>
      )}

      {post && !verdict.allowed && verdict.reason === 'cannotSubmit' && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          <Text size="sm">{STORYLINE_REFUSALS.cannotSubmit}.</Text>
        </Alert>
      )}

      {post && !verdict.allowed && verdict.reason === 'aboveRating' && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          <Text size="sm">
            Cannot be submitted. Your post is rated {getBrowsingLevelLabel(post.nsfwLevel)}; this
            storyline accepts up to {ceiling}.
            {onStartOwn ? ' You can start your own storyline from it instead.' : ''}
          </Text>
        </Alert>
      )}

      {post && verdict.allowed && ownerAdd && (
        <Text size="sm" c="dimmed">
          {inserting
            ? 'It goes in here right away, and the chapters after it move down one. No review, no cost.'
            : branch
            ? 'It joins your storyline right away as a side path after this chapter. No review, no cost.'
            : 'It joins your storyline as the next chapter right away. No review, no cost.'}
        </Text>
      )}

      {post && verdict.allowed && !ownerAdd && (
        <Text size="sm" c="dimmed">
          {verdict.awaitingScan
            ? 'Your post is still being rated. It is submitted now and reaches the creator once rating finishes, or is returned if it comes out above the limit. '
            : ''}
          {isCollaborator
            ? 'You are an endorsed collaborator, so it skips review and goes straight into the story.'
            : `Goes to the creator for review. If they do not answer in ${STORYLINE_CONTINUATION_EXPIRY_DAYS} days it expires${
                price > 0 ? ` and your ${storylinePriceLabel(price)} is refunded` : ''
              }.`}
        </Text>
      )}

      {error && (
        <Alert color="red">
          <Text size="sm">{error}</Text>
        </Alert>
      )}

      <Group justify="flex-end" gap="xs">
        {post && !verdict.allowed && onStartOwn && (
          <Button variant="default" onClick={onStartOwn}>
            Start my own storyline
          </Button>
        )}
        <Button disabled={!post || !verdict.allowed} loading={submitting} onClick={onSubmit}>
          {inserting
            ? 'Insert chapter'
            : ownerAdd
            ? 'Add chapter'
            : price > 0
            ? `Submit for ${storylinePriceLabel(price)}`
            : 'Submit'}
        </Button>
      </Group>
    </Stack>
  );
}

function StorylineSubmitted({
  outcome,
  price,
  inserting,
  branch,
  onLeave,
}: {
  outcome: StorylineSubmitOutcome;
  price: number;
  inserting: boolean;
  branch: boolean;
  onLeave?: () => void;
}) {
  if (outcome === 'added')
    return (
      <Alert color="green" icon={<IconCheck size={18} />}>
        <Text size="sm">
          {inserting
            ? 'Inserted into your storyline.'
            : branch
            ? 'Added to your storyline as a branch.'
            : 'Added to your storyline as the next chapter.'}
        </Text>
      </Alert>
    );

  if (outcome === 'approved')
    return (
      <Alert color="green" icon={<IconCheck size={18} />}>
        <Text size="sm">Added to the storyline. As an endorsed collaborator you skip review.</Text>
      </Alert>
    );

  return (
    <Alert
      color="blue"
      icon={<IconClock size={18} />}
      title="Submitted, waiting for approval"
      data-testid="storyline-submitted-pending"
    >
      <Text size="sm">
        {outcome === 'awaitingScan'
          ? 'It goes to the storyline owner once your post finishes being rated, and joins the story when they accept it.'
          : "It is waiting for the storyline owner's approval, and joins the story when they accept it."}{' '}
        If they do not answer in {STORYLINE_CONTINUATION_EXPIRY_DAYS} days it expires
        {price > 0 ? ` and your ${storylinePriceLabel(price)} is refunded` : ''}.
      </Text>
      <Anchor component={Link} href={STORYLINE_QUEUE_SENT_URL} size="sm" onClick={onLeave}>
        See your sent continuations
      </Anchor>
    </Alert>
  );
}
