import { Anchor } from '@mantine/core';
import { creatorScoreGrowsWhen } from '~/components/Account/creator-score-copy';
import { NextLink } from '~/components/NextLink/NextLink';
import {
  CREATOR_JOURNEY_HREF,
  CREATOR_SCORE_EXPLAINER_HREF,
} from '~/shared/constants/creator-journey.constants';
import type { CreatorScoreTier, CreatorScoreUnlock } from '~/shared/utils/creator-score-unlocks';
import {
  creatorScoreGateState,
  describeCreatorScoreUnlocks,
} from '~/shared/utils/creator-score-unlocks';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type GateMessageProps = {
  /** Null or undefined when only the server's refusal is known, which is not the same as zero. */
  score: number | null | undefined;
  /** The viewer's total, when `score` is another kind (the Creator Program compares the aggregate). */
  total?: number | null;
  required: number;
};

/**
 * The body of every Creator Score requirement. The caller keeps its own title naming the gate and wraps
 * this in its own text element; this says where the viewer stands and, below the gate, the nearest step
 * they can take.
 */
export function CreatorScoreGateMessage(props: GateMessageProps) {
  const journey = !!useFeatureFlags().creatorJourney;
  const { data: ladder } = trpc.creatorJourney.getLadder.useQuery(undefined, {
    staleTime: Infinity,
    enabled: journey && props.score != null && props.score < props.required,
  });
  return <CreatorScoreGateMessageView {...props} ladder={ladder} journey={journey} />;
}

export function CreatorScoreGateMessageView({
  score,
  total,
  required,
  ladder,
  journey,
}: GateMessageProps & {
  ladder: { unlocks: CreatorScoreUnlock[]; tiers: CreatorScoreTier[] } | undefined;
  /** Off while Creator Journey is flagged off for the viewer: no tier names and no journey link. */
  journey: boolean;
}) {
  const state = creatorScoreGateState({
    score,
    total,
    required,
    unlocks: ladder?.unlocks ?? [],
    tiers: ladder?.tiers ?? [],
  });
  const explainerLink = (label: string) => (
    <Anchor component={NextLink} href={CREATOR_SCORE_EXPLAINER_HREF} inherit>
      {label}
    </Anchor>
  );
  const journeyLink = journey ? (
    <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
      See your journey
    </Anchor>
  ) : (
    explainerLink('See how Creator Score works')
  );

  if (state.kind === 'met')
    return (
      <>
        Your Creator Score is {numberWithCommas(Math.floor(state.score))}. {journeyLink}
      </>
    );

  if (state.kind === 'unknown')
    return (
      <>
        Your Creator Score grows when {creatorScoreGrowsWhen}, and it updates once a day.{' '}
        {journeyLink}
      </>
    );

  if (state.kind === 'noScore')
    return (
      <>
        You don&apos;t have a Creator Score yet. It starts when {creatorScoreGrowsWhen}, and it
        updates once a day. {explainerLink('See how Creator Score works')}
      </>
    );

  if (!journey)
    return (
      <>
        You&apos;re at {numberWithCommas(Math.floor(state.score))},{' '}
        {numberWithCommas(Math.ceil(required - state.score))} to go. Scores update once a day.{' '}
        {explainerLink('See what moves your score')}
      </>
    );

  if (!ladder)
    return (
      <>
        You&apos;re at {numberWithCommas(Math.floor(state.score))}. {journeyLink}
      </>
    );

  if (state.kind === 'near')
    return (
      <>
        You&apos;re at {numberWithCommas(Math.floor(state.score))},{' '}
        {numberWithCommas(Math.ceil(state.gap))} to go. Scores update once a day.{' '}
        {explainerLink('See what moves your score')}
      </>
    );

  const { next } = state;
  return (
    <>
      You&apos;re at {numberWithCommas(Math.floor(state.score))}. Your next step is{' '}
      {next.tier ? `${next.tier.name} at ` : 'a score of '}
      {numberWithCommas(next.minScore)}, which unlocks: {describeCreatorScoreUnlocks(next.unlocks)}.{' '}
      {journeyLink}
    </>
  );
}
