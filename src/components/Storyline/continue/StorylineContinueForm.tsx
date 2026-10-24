import { Alert, Anchor, Badge, Button, Group, Stack, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconBolt,
  IconCheck,
  IconClock,
  IconShieldHalf,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useId } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { StorylineThumb, type StorylineThumbImage } from '~/components/Storyline/StorylineThumb';
import { STORYLINE_QUEUE_SENT_URL } from '~/components/Placement/queue-routes';
import {
  STORYLINE_CONTINUATION_EXPIRY_DAYS,
  STORYLINE_CONTINUE_POST_LIMIT,
  storylinePriceLabel,
  storylineSubmitVerdict,
  type StorylineClosedReason,
} from '~/components/Storyline/storyline-ui';
import { getBrowsingLevelLabel } from '~/shared/constants/browsingLevel.constants';
import { formatDate } from '~/utils/date-helpers';

export type StorylineContinuePost = {
  id: number;
  title: string | null;
  nsfwLevel: number;
  publishedAt?: Date | null;
  imageCount?: number;
  cover?: StorylineThumbImage | null;
};

export type StorylineSubmitOutcome = 'pending' | 'approved' | 'awaitingScan' | 'added';

/** Sizes the tile's image request. */
const TILE_WIDTH = 140;

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
  morePosts,
  postId,
  onPostChange,
  onSubmit,
  onStartOwn,
  ownerAdd = false,
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
  /** Only the most recent posts are offered. */
  morePosts?: boolean;
  postId: number | null;
  onPostChange: (postId: number | null) => void;
  onSubmit: () => void;
  onStartOwn?: () => void;
  /** The viewer owns the storyline: the post joins as the next chapter at once, unpriced. */
  ownerAdd?: boolean;
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

  const pickerLabelId = useId();
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

  if (outcome) return <StorylineSubmitted outcome={outcome} price={price} onLeave={onLeave} />;

  if (!verdict.allowed && verdict.reason !== 'aboveRating' && verdict.reason !== 'notRated')
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
              {ownerAdd
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

      <Stack gap={6}>
        <Text size="sm" fw={500} id={pickerLabelId}>
          Your post
        </Text>
        {postsLoading ? (
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <StorylineThumb key={i} image={undefined} width={TILE_WIDTH} fluid />
            ))}
          </div>
        ) : postsError ? (
          <Text size="sm" c="red">
            Couldn&apos;t load your posts.
          </Text>
        ) : !posts.length ? (
          <Text size="sm" c="dimmed">
            {alreadyChapters
              ? 'All your recent posts are already chapters. Make a new post to continue the story.'
              : 'You have no published posts.'}{' '}
            <Anchor component={Link} href="/posts/create">
              Create a post
            </Anchor>
          </Text>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby={pickerLabelId}
            className="-m-1 grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto p-1"
          >
            {posts.map((candidate) => (
              <StorylinePostTile
                key={candidate.id}
                post={candidate}
                ceiling={ceiling}
                aboveCeiling={isAboveCeiling(candidate.nsfwLevel)}
                selected={candidate.id === postId}
                onSelect={() => onPostChange(candidate.id)}
              />
            ))}
          </div>
        )}
        {alreadyChapters > 0 && posts.length > 0 && (
          <Text size="xs" c="dimmed">
            {alreadyChapters === 1
              ? '1 of your posts is already a chapter, so it isn’t listed.'
              : `${alreadyChapters} of your posts are already chapters, so they aren’t listed.`}
          </Text>
        )}
        {morePosts && (
          <Text size="xs" c="dimmed">
            Your {STORYLINE_CONTINUE_POST_LIMIT} most recent published posts.
          </Text>
        )}
      </Stack>

      {post && !verdict.allowed && verdict.reason === 'notRated' && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          <Text size="sm">This post has not been rated yet. Try again once it has been.</Text>
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
          It joins your storyline as the next chapter right away. No review, no cost.
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
          {ownerAdd
            ? 'Add chapter'
            : price > 0
            ? `Submit for ${storylinePriceLabel(price)}`
            : 'Submit'}
        </Button>
      </Group>
    </Stack>
  );
}

function StorylinePostTile({
  post,
  ceiling,
  aboveCeiling,
  selected,
  onSelect,
}: {
  post: StorylineContinuePost;
  ceiling: string;
  aboveCeiling: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const name = post.title || (post.publishedAt ? formatDate(post.publishedAt) : `Post ${post.id}`);
  const rating = post.nsfwLevel ? getBrowsingLevelLabel(post.nsfwLevel) : 'Not rated yet';

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={
        aboveCeiling
          ? `${name}, above this storyline's ${ceiling} limit`
          : `${name}, ${post.nsfwLevel ? `rated ${rating}` : 'not rated yet'}`
      }
      onClick={onSelect}
      className={clsx(
        'flex min-w-0 flex-col gap-1 rounded-lg p-1 text-left outline-none',
        'focus-visible:ring-2 focus-visible:ring-blue-5/50',
        selected && 'ring-2 ring-blue-5 focus-visible:ring-blue-5'
      )}
    >
      <StorylineThumb image={post.cover ?? null} width={TILE_WIDTH} fluid dimmed={aboveCeiling}>
        {aboveCeiling && (
          <span className="absolute inset-x-1 bottom-1 rounded-full bg-black/55 px-2 py-0.5 text-center text-xs font-semibold text-white backdrop-blur-sm">
            Above {ceiling}
          </span>
        )}
        {selected && (
          <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-blue-6 text-white">
            <IconCheck size={14} stroke={3} />
          </span>
        )}
      </StorylineThumb>
      <Text size="xs" fw={500} lineClamp={1}>
        {name}
      </Text>
      <div className="flex items-center gap-1.5">
        <Badge variant="light" color="gray" size="xs" radius="xl">
          {rating}
        </Badge>
        {!!post.imageCount && (
          <Text size="xs" c="dimmed" lineClamp={1} data-testid="storyline-post-image-count">
            {post.imageCount} {post.imageCount === 1 ? 'image' : 'images'}
          </Text>
        )}
      </div>
    </button>
  );
}

function StorylineSubmitted({
  outcome,
  price,
  onLeave,
}: {
  outcome: StorylineSubmitOutcome;
  price: number;
  onLeave?: () => void;
}) {
  if (outcome === 'added')
    return (
      <Alert color="green" icon={<IconCheck size={18} />}>
        <Text size="sm">Added to your storyline as the next chapter.</Text>
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
