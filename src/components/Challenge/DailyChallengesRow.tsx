import { ChallengeCard } from '~/components/Cards/ChallengeCard';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { trpc } from '~/utils/trpc';

/**
 * Horizontal row of the active + next few upcoming daily (System) challenges. Mirrors
 * FeaturedChallengeEvents: a mobile-friendly horizontal scroll of ChallengeCards. Renders nothing
 * while loading or when there are no daily challenges to show.
 */
export function DailyChallengesRow() {
  const {
    data: challenges,
    isLoading,
    isRefetching,
  } = trpc.challenge.getDaily.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });

  const { items: filteredChallenges, loadingPreferences } = useApplyHiddenPreferences({
    type: 'challenges',
    data: challenges ?? [],
    isRefetching,
  });

  if (isLoading || loadingPreferences || filteredChallenges.length === 0) return null;

  return (
    <TwScrollX className="flex gap-4">
      {filteredChallenges.map((challenge) => (
        <div key={challenge.id} className="w-[320px] shrink-0">
          <ChallengeCard data={challenge} />
        </div>
      ))}
    </TwScrollX>
  );
}
