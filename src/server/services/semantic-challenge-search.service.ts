import { deriveDomainCurrency } from '~/server/games/daily-challenge/challenge-currency';
import { logToAxiom } from '~/server/logging/client';
import { ChallengeSort } from '~/server/schema/challenge.schema';
import type { SemanticChallengeSearchInput } from '~/server/schema/semantic-challenge-search.schema';
import { getInfiniteChallenges } from '~/server/services/challenge.service';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import {
  queryVerdictLevel,
  recordRefusal,
  semanticQueryRefusal,
  refusedByGuard,
  refusedByWord,
  semanticSearchPrelude,
  withRefusal,
  type QueryRefusal,
  type QueryTracker,
} from '~/server/services/semantic-query-guard';
import {
  auditedTextCandidates,
  collectPage,
  MAX_HITS_PER_USER,
  searchServiceSource,
  viewerExcludedUserIds,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
} from '~/server/services/semantic-search-client';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { ChallengeSource, ChallengeStatus, MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

/** The feed's default when no status is picked: running and upcoming. */
const OPEN_STATUSES = [ChallengeStatus.Active, ChallengeStatus.Scheduled];
const LISTED_STATUSES = Object.values(ChallengeStatus).filter(
  (s) => s !== ChallengeStatus.Cancelled
);

type HydratedChallenge = Awaited<ReturnType<typeof getInfiniteChallenges>>['items'][number];

const searchServiceCandidates = searchServiceSource('challenges', {
  notFoundMessage: 'Challenge not found',
});

/**
 * The semantic path's query audit, for the feed's own text search (getInfinite with a query): the
 * search's fallback and a Cancelled-only filter reach it with the same text. `level` is the feed's
 * effective level, 0 meaning no level filter. Returns 'refuse', or the level to search at and
 * whether a verdict narrowed it (true even when the level was already within the safe levels).
 */
export async function challengeTextQueryLevel({
  query,
  level,
  user,
  track,
}: {
  query: string;
  level: number;
  user?: SessionUser;
  track?: QueryTracker;
}): Promise<{ level: number; narrowed: boolean } | 'refuse'> {
  const browsingLevel = level || allBrowsingLevelsFlag;
  const addonData = await getBrowsingSettingAddons();
  const { disablePoi } = resolveBrowsingSettingsAddons(addonData, browsingLevel, {
    isModerator: user?.isModerator,
  });
  const refusal = await semanticQueryRefusal(query, {
    browsingLevel,
    disablePoi,
    isModerator: user?.isModerator,
  });
  recordRefusal(track, refusal, query, 'challenges_text');
  const verdict = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  if (verdict === 'refuse') return 'refuse';
  // An unnarrowed query keeps the feed's own level, so 0 (no filter) still shows unrated rows.
  return { level: verdict === browsingLevel ? level : verdict, narrowed: !!refusal };
}

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
    refused: false as boolean,
  };
  const prelude = await semanticSearchPrelude({
    index: 'challenges_semantic',
    query: input.query,
    requestedLevel: input.browsingLevel,
    user,
    isGreen,
    browsingLevelCap,
    track,
  });
  if ('refusedBy' in prelude) return withRefusal(none, user, prelude.refusedBy);
  const { browsingLevel, hidden, refusalOf } = prelude;

  const statuses = input.status?.length
    ? input.status
    : input.includeEnded
    ? LISTED_STATUSES
    : OPEN_STATUSES;
  const excludedUserIds = viewerExcludedUserIds(hidden);
  const excluded = new Set(excludedUserIds);
  const filter: CandidateFilter = {
    gate: {
      kind: 'challenge',
      nsfwLevels: Flags.instanceToArray(browsingLevel),
      domainBuzzType: deriveDomainCurrency(isGreen),
      canAccessUserChallenges,
      visibleBefore: now().toISOString(),
    },
    userIds: input.userId ? [input.userId] : undefined,
    excludedUserIds,
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
  let hydrated = 0;
  const hydrate: Hydrate<HydratedChallenge> = async (ids) => {
    // A point can outlive the challenge's visibility (a cover's rating or scan changes no
    // challenge row), so the feed's own query re-applies every gate to the current rows.
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
      ownRowsExempt: false,
      isGreen,
      canAccessUserChallenges,
    });
    const byId = new Map(items.map((c) => [c.id, c]));
    const kept: HydratedChallenge[] = [];
    // In rank order, so the cap keeps each creator's best matches.
    for (const id of ids) {
      const challenge = byId.get(id);
      if (!challenge || excluded.has(challenge.createdById)) continue;
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

  let correctionVerdict: QueryRefusal = false;
  const search = auditedTextCandidates({
    source: candidateSource,
    text: input.query,
    filter,
    viewer: { isModerator: !!user?.isModerator },
    audit: async (correction) => (correctionVerdict = await refusalOf(correction, 'correction')),
  });
  const page = await collectPage({
    candidates: search.candidates,
    hydrate,
    offset: input.cursor ?? 0,
    limit: input.limit,
  });

  // Tells "empty after hydration" apart from "no matches".
  logToAxiom({
    type: 'info',
    name: 'semantic-challenge-search',
    hydrated,
    payload: { returned: search.state.returned, shown: page.items.length },
  });

  if (search.state.refused)
    return withRefusal(none, user, refusedByWord(correctionVerdict) ?? 'error');
  return withRefusal(
    { ...page, correctedQuery: search.state.correctedQuery },
    user,
    page.items.length ? undefined : refusedByGuard(search.state.first?.guard)
  );
}
