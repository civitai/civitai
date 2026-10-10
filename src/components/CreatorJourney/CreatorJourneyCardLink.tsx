import { Anchor, Text } from '@mantine/core';
import { NextLink } from '~/components/NextLink/NextLink';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import {
  buildCreatorScoreLadder,
  describeCreatorScoreUnlocks,
  nextCreatorScoreRung,
  pendingCreatorScoreUnlocks,
} from '~/shared/utils/creator-score-unlocks';
import { creatorAggregateScoreFromMeta, creatorScoreFromMeta } from '~/shared/utils/creator-score';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

/** The account score card's pointer to the journey page, naming the next rung when there is one. */
export function CreatorJourneyCardLink({ meta }: { meta: unknown }) {
  const { data: ladder } = trpc.creatorJourney.getLadder.useQuery(undefined, {
    staleTime: Infinity,
  });
  const kinds = {
    total: creatorScoreFromMeta(meta),
    aggregate: creatorAggregateScoreFromMeta(meta),
  };
  const next =
    ladder && kinds.total > 0
      ? nextCreatorScoreRung(buildCreatorScoreLadder(ladder.unlocks, ladder.tiers), kinds.total)
      : null;
  const pending = next ? pendingCreatorScoreUnlocks(next, kinds) : [];

  return (
    <Text size="sm" c="dimmed" ta="center" mt="sm">
      {next && (
        <>
          {numberWithCommas(Math.ceil(next.minScore - kinds.total))} to{' '}
          {next.tier?.name ?? numberWithCommas(next.minScore)}.
          {pending.length > 0 && ` Unlocks: ${describeCreatorScoreUnlocks(pending)}.`}{' '}
        </>
      )}
      <Anchor component={NextLink} href={CREATOR_JOURNEY_HREF} inherit>
        See your journey
      </Anchor>
    </Text>
  );
}
