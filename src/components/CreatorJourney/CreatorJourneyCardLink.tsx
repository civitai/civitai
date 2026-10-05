import { Anchor, Text } from '@mantine/core';
import { NextLink } from '~/components/NextLink/NextLink';
import { CREATOR_JOURNEY_HREF } from '~/shared/constants/creator-journey.constants';
import {
  buildCreatorScoreLadder,
  describeCreatorScoreUnlocks,
  nextCreatorScoreRung,
} from '~/shared/utils/creator-score-unlocks';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

/** The account score card's pointer to the journey page, naming the next rung when there is one. */
export function CreatorJourneyCardLink({ total }: { total: number | undefined }) {
  const { data: ladder } = trpc.creatorJourney.getLadder.useQuery(undefined, {
    staleTime: Infinity,
  });
  const next =
    ladder && total != null && total > 0
      ? nextCreatorScoreRung(buildCreatorScoreLadder(ladder.unlocks, ladder.tiers), total)
      : null;
  const pending = next?.unlocks.filter((u) => u.minScore > (total ?? 0)) ?? [];

  return (
    <Text size="sm" c="dimmed" ta="center" mt="sm">
      {next && total != null && (
        <>
          {numberWithCommas(Math.ceil(next.minScore - total))} to{' '}
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
