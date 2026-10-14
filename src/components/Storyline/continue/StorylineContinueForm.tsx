import { Alert, Badge, Button, Group, Select, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconClock } from '@tabler/icons-react';
import {
  STORYLINE_CONTINUATION_EXPIRY_DAYS,
  storylinePriceLabel,
  storylineRatingLabel,
  storylineSubmitVerdict,
  type StorylineContinueMode,
} from '~/components/Storyline/storyline-ui';

export type StorylineContinuePost = { id: number; title: string | null; nsfwLevel: number };

/** What happened after a submit, as the server reported it. */
export type StorylineSubmitOutcome = 'pending' | 'approved' | 'awaitingScan';

const refusalCopy = {
  ownStoryline: 'This is your storyline. Add your next chapter from the storyline page instead.',
  complete: 'This storyline is complete and is not taking continuations.',
  collaboratorsOnly: 'Only the creator’s endorsed collaborators can continue this storyline.',
} as const;

export function StorylineContinueForm({
  viewerId,
  storyline,
  parentTitle,
  mode,
  price,
  isCollaborator,
  posts,
  postId,
  onPostChange,
  onSubmit,
  onStartOwn,
  submitting,
  outcome,
  error,
}: {
  viewerId: number;
  storyline: {
    title: string;
    userId: number;
    status: 'Ongoing' | 'Complete';
    maxNsfwLevel: number;
  };
  parentTitle: string | null;
  mode: StorylineContinueMode;
  price: number;
  isCollaborator: boolean;
  /** The viewer's own posts to choose from. */
  posts: StorylineContinuePost[];
  postId: number | null;
  onPostChange: (postId: number | null) => void;
  onSubmit: () => void;
  onStartOwn?: () => void;
  submitting?: boolean;
  outcome?: StorylineSubmitOutcome | null;
  error?: string | null;
}) {
  const post = posts.find((candidate) => candidate.id === postId) ?? null;
  const ceiling = storylineRatingLabel(storyline.maxNsfwLevel);
  const verdict = storylineSubmitVerdict({
    postLevel: post?.nsfwLevel ?? 0,
    viewerId,
    storyline,
    mode,
    isCollaborator,
  });

  if (outcome) return <StorylineSubmitted outcome={outcome} price={price} />;

  // Refusals that do not depend on the post are said before any post is picked.
  if (!verdict.allowed && verdict.reason !== 'aboveRating')
    return (
      <Alert color="gray" icon={<IconAlertTriangle size={18} />}>
        <Text size="sm">{refusalCopy[verdict.reason]}</Text>
      </Alert>
    );

  return (
    <Stack gap="md">
      <Text size="sm">
        Continue <b>{storyline.title}</b>
        {parentTitle ? (
          <>
            {' '}
            from <b>{parentTitle}</b>
          </>
        ) : null}
      </Text>

      <Group gap={6}>
        <Badge variant="light" color="gray">
          Accepts up to {ceiling}
        </Badge>
        <Badge variant="light" color={price > 0 ? 'yellow' : 'green'}>
          {price > 0 ? `Costs ${storylinePriceLabel(price)}` : 'Free'}
        </Badge>
      </Group>

      <Select
        label="Your post"
        placeholder={posts.length ? 'Choose one of your posts' : 'You have no published posts'}
        data={posts.map((candidate) => ({
          value: String(candidate.id),
          label: `${candidate.title || `Post ${candidate.id}`} · ${
            candidate.nsfwLevel ? storylineRatingLabel(candidate.nsfwLevel) : 'not rated yet'
          }`,
        }))}
        value={postId ? String(postId) : null}
        onChange={(value) => onPostChange(value ? Number(value) : null)}
        searchable
        disabled={!posts.length}
      />

      {post && !verdict.allowed && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          <Text size="sm">
            Cannot be submitted. Your post is rated {storylineRatingLabel(post.nsfwLevel)}; this
            storyline accepts up to {ceiling}. You can start your own storyline from it instead.
          </Text>
        </Alert>
      )}

      {post && verdict.allowed && (
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
          {price > 0 ? `Submit for ${storylinePriceLabel(price)}` : 'Submit'}
        </Button>
      </Group>
    </Stack>
  );
}

function StorylineSubmitted({
  outcome,
  price,
}: {
  outcome: StorylineSubmitOutcome;
  price: number;
}) {
  if (outcome === 'approved')
    return (
      <Alert color="green" icon={<IconCheck size={18} />}>
        <Text size="sm">Added to the storyline. As an endorsed collaborator you skip review.</Text>
      </Alert>
    );

  return (
    <Alert color="blue" icon={<IconClock size={18} />}>
      <Text size="sm">
        {outcome === 'awaitingScan'
          ? 'Submitted. It reaches the creator once your post finishes being rated.'
          : 'Submitted. It is waiting for the creator to review.'}{' '}
        If they do not answer in {STORYLINE_CONTINUATION_EXPIRY_DAYS} days it expires
        {price > 0 ? ` and your ${storylinePriceLabel(price)} is refunded` : ''}.
      </Text>
    </Alert>
  );
}
