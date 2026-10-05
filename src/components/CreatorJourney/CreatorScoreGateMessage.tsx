import { Anchor } from '@mantine/core';
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
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type GateMessageProps = {
  /** Null or undefined when only the server's refusal is known, which is not the same as zero. */
  score: number | null | undefined;
  required: number;
};

/**
 * The body of every Creator Score refusal. The caller keeps its own title naming the gate and wraps this
 * in its own text element; this says where the viewer stands and the nearest step they can take.
 */
export function CreatorScoreGateMessage(props: GateMessageProps) {
  const { data: ladder } = trpc.creatorJourney.getLadder.useQuery(undefined, {
    staleTime: Infinity,
  });
  return <CreatorScoreGateMessageView {...props} ladder={ladder} />;
}

export function CreatorScoreGateMessageView({
  score,
  required,
  ladder,
}: GateMessageProps & {
  ladder: { unlocks: CreatorScoreUnlock[]; tiers: CreatorScoreTier[] } | undefined;
}) {
  const state = creatorScoreGateState({
    score,
    required,
    unlocks: ladder?.unlocks ?? [],
    tiers: ladder?.tiers ?? [],
  });
  const journeyLink = (
    <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
      See your journey
    </Anchor>
  );

  if (state.kind === 'unknown')
    return (
      <>
        Your Creator Score grows when people react to, comment on or download what you share, and it
        updates once a day. {journeyLink}
      </>
    );

  if (state.kind === 'noScore')
    return (
      <>
        You don&apos;t have a Creator Score yet. It starts when people react to, comment on or
        download what you share, and it updates once a day.{' '}
        <Anchor component={NextLink} href={CREATOR_SCORE_EXPLAINER_HREF} inherit>
          See how Creator Score works
        </Anchor>
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
        <Anchor component={NextLink} href={CREATOR_SCORE_EXPLAINER_HREF} inherit>
          See what moves your score
        </Anchor>
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
