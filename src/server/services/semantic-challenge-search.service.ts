import { deriveDomainCurrency } from '~/server/games/daily-challenge/challenge-currency';
import { getEffectiveBrowsingLevel } from '~/server/games/daily-challenge/challenge-visibility';
import { logToAxiom } from '~/server/logging/client';
import { ChallengeSort } from '~/server/schema/challenge.schema';
import type { SemanticChallengeSearchInput } from '~/server/schema/semantic-challenge-search.schema';
import { getInfiniteChallenges } from '~/server/services/challenge.service';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import {
  queryVerdictLevel,
  recordRefusal,
  resolveSemanticBrowsingLevel,
  semanticQueryRefusal,
  type QueryRefusal,
  type QueryStage,
  type QueryTracker,
} from '~/server/services/semantic-query-guard';
import {
  collectPage,
  searchServiceSource,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
} from '~/server/services/semantic-search-client';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { Flags } from '~/shared/utils/flags';
import { ChallengeSource, ChallengeStatus, MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

/** One creator's user challenges shown on a page at most, so a prolific creator cannot fill it. */
export const MAX_HITS_PER_USER = 3;

/** The feed's default when no status is picked: running and upcoming. */
const OPEN_STATUSES = [ChallengeStatus.Active, ChallengeStatus.Scheduled];
const LISTED_STATUSES = Object.values(ChallengeStatus).filter(
  (s) => s !== ChallengeStatus.Cancelled
);

type HydratedChallenge = Awaited<ReturnType<typeof getInfiniteChallenges>>['items'][number];

const searchServiceCandidates = searchServiceSource('challenges', {
  notFoundMessage: 'Challenge not found',
});

export async function searchSemanticChallenges({
  input,
  user,
  isGreen,
  canAccessUserChallenges,
  browsingLevelCap,
  track,
  candidateSource = searchServiceCandidates,
  now = () => new Date(),
}: {
  input: SemanticChallengeSearchInput;
  user?: SessionUser;
  isGreen: boolean;
  canAccessUserChallenges: boolean;
  /** The site's cap (requestDomainBrowsingLevelCap); undefined on an uncapped site. */
  browsingLevelCap: number | undefined;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
  now?: () => Date;
}) {
  const none = {
    items: [] as HydratedChallenge[],
    nextCursor: undefined,
    correctedQuery: undefined,
  };
  let browsingLevel = resolveSemanticBrowsingLevel(input.browsingLevel, user);
  if (browsingLevelCap !== undefined)
    browsingLevel = Flags.intersection(browsingLevel, browsingLevelCap) || browsingLevelCap;
  const addonData = await getBrowsingSettingAddons();
  const { disablePoi } = resolveBrowsingSettingsAddons(addonData, browsingLevel, {
    isModerator: user?.isModerator,
  });
  const refusalOf = async (text: string, stage: QueryStage) => {
    const refusal = await semanticQueryRefusal(text, {
      browsingLevel,
      disablePoi,
      isModerator: user?.isModerator,
    });
    recordRefusal(track, refusal, text, 'challenges_semantic', stage);
    return refusal;
  };
  const refusal = await refusalOf(input.query, 'query');
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  if (verdictLevel === 'refuse') return none;
  // The level the feed itself filters on, so the candidates and the hydration agree.
  browsingLevel = getEffectiveBrowsingLevel({
    isGreen,
    isLoggedIn: !!user,
    requested: verdictLevel,
  });

  const statuses = input.status?.length
    ? input.status
    : input.includeEnded
    ? LISTED_STATUSES
    : OPEN_STATUSES;
  const filter: CandidateFilter = {
    gate: {
      kind: 'challenge',
      nsfwLevels: Flags.instanceToArray(browsingLevel),
      domainBuzzType: deriveDomainCurrency(isGreen),
      canAccessUserChallenges,
      visibleBefore: now().toISOString(),
    },
    userIds: input.userId ? [input.userId] : undefined,
    anyOf: {
      status: statuses,
      source: input.source?.length ? input.source : undefined,
      modelVersionIds: input.modelVersionId ? [input.modelVersionId] : undefined,
      eventId: input.challengeEventId ? [input.challengeEventId] : undefined,
    },
    // Only challenges outside any event: the point's eventId is null.
    mustNot: input.excludeEventChallenges
      ? [{ must_not: [{ is_null: { key: 'eventId' } }] }]
      : undefined,
  };

  const perUser = new Map<number, number>();
  let returned = 0;
  let hydrated = 0;
  const hydrate: Hydrate<HydratedChallenge> = async (ids) => {
    // The feed's own query: Qdrant only proposes candidates, and a point can outlive the
    // challenge's visibility (a cover's rating or scan changes no challenge row). It re-applies
    // every gate, blocks included, to the current rows.
    const { items } = await getInfiniteChallenges({
      ids,
      limit: ids.length,
      sort: ChallengeSort.Newest,
      period: MetricTimeframe.AllTime,
      status: statuses,
      source: input.source,
      userId: input.userId,
      modelVersionId: input.modelVersionId,
      challengeEventId: input.challengeEventId,
      excludeEventChallenges: input.excludeEventChallenges,
      includeEnded: input.includeEnded,
      participation: input.participation,
      browsingLevel,
      currentUserId: user?.id,
      isGreen,
      canAccessUserChallenges,
    });
    const byId = new Map(items.map((c) => [c.id, c]));
    const kept: HydratedChallenge[] = [];
    // In rank order, so the cap keeps each creator's best matches.
    for (const id of ids) {
      const challenge = byId.get(id);
      if (!challenge) continue;
      // System and Mod challenges share their creators; only user challenges are capped.
      if (challenge.source === ChallengeSource.User) {
        const count = perUser.get(challenge.createdById) ?? 0;
        if (count >= MAX_HITS_PER_USER) continue;
        perUser.set(challenge.createdById, count + 1);
      }
      kept.push(challenge);
    }
    hydrated += kept.length;
    return kept;
  };

  let correctedQuery: string | undefined;
  let correctedRefusal: QueryRefusal | undefined;
  const page = await collectPage({
    candidates: async (offset, limit) => {
      const result = await candidateSource({ query: { text: input.query }, filter, offset, limit });
      // The service embeds its spelling correction, not the text audited above.
      if (correctedRefusal === undefined && result.correctedQuery !== undefined)
        correctedRefusal =
          result.correctedQuery !== input.query &&
          (await refusalOf(result.correctedQuery, 'correction'));
      if (correctedRefusal) return [];
      correctedQuery ??= result.correctedQuery;
      returned += result.ids.length;
      return result.ids;
    },
    hydrate,
    offset: input.cursor ?? 0,
    limit: input.limit,
  });

  // Tells "empty after hydration" apart from "no matches".
  logToAxiom({
    type: 'info',
    name: 'semantic-challenge-search',
    returned,
    hydrated,
    shown: page.items.length,
  }).catch(() => undefined);

  if (correctedRefusal) return none;
  return { ...page, correctedQuery };
}
