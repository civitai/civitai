import { logToAxiom } from '~/server/logging/client';
import type { SemanticCrucibleSearchInput } from '~/server/schema/semantic-crucible-search.schema';
import { crucibleListSelect } from '~/server/selectors/crucible.selector';
import { getCrucibles, withEntryCounts } from '~/server/services/crucible.service';
import {
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
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { CrucibleSort } from '~/server/common/enums';
import { Flags } from '~/shared/utils/flags';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

/** The feed's default when no status is picked: running and upcoming. */
const OPEN_STATUSES = [CrucibleStatus.Active, CrucibleStatus.Pending];

type ListedCrucible = Awaited<
  ReturnType<typeof getCrucibles<typeof crucibleListSelect>>
>['items'][number];
type HydratedCrucible = Awaited<ReturnType<typeof withEntryCounts<ListedCrucible>>>[number];

const searchServiceCandidates = searchServiceSource('crucibles', {
  notFoundMessage: 'Crucible not found',
});

export async function searchSemanticCrucibles({
  input,
  user,
  isGreen,
  browsingLevelCap,
  track,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticCrucibleSearchInput;
  user?: SessionUser;
  isGreen: boolean;
  /** The site's cap (requestDomainBrowsingLevelCap); undefined on an uncapped site. */
  browsingLevelCap: number | undefined;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
}) {
  const none = {
    items: [] as HydratedCrucible[],
    nextCursor: undefined,
    correctedQuery: undefined,
    refused: false as boolean,
  };
  const prelude = await semanticSearchPrelude({
    index: 'crucibles_semantic',
    query: input.query,
    requestedLevel: input.browsingLevel,
    user,
    isGreen,
    browsingLevelCap,
    track,
  });
  if ('refusedBy' in prelude) return withRefusal(none, user, prelude.refusedBy);
  const { browsingLevel, hidden, refusalOf } = prelude;

  const statuses = input.status?.length ? input.status : OPEN_STATUSES;
  const excludedUserIds = viewerExcludedUserIds(hidden);
  const excluded = new Set(excludedUserIds);
  const filter: CandidateFilter = {
    gate: {
      kind: 'crucible',
      nsfwLevels: Flags.instanceToArray(browsingLevel),
      // Mirrors the feed's textNsfw gate.
      allowTextNsfw: Flags.intersects(browsingLevel, nsfwBrowsingLevelsFlag),
    },
    excludedUserIds,
    anyOf: {
      status: statuses,
      contentType: input.contentType ? [input.contentType] : undefined,
    },
  };

  const perUser = new Map<number, number>();
  let hydrated = 0;
  const hydrate: Hydrate<HydratedCrucible> = async (ids) => {
    // A point can outlive the crucible's visibility (a cover's rating or scan changes no crucible
    // row), so the feed's own query re-applies every gate to the current rows.
    const { items } = await getCrucibles({
      input: {
        status: statuses,
        contentType: input.contentType,
        browsingLevel,
        sort: CrucibleSort.Newest,
        limit: ids.length,
      },
      ids,
      select: crucibleListSelect,
      isModerator: user?.isModerator ?? false,
      viewerId: user?.id,
      // A minor-narrowed query must not show the viewer's own crucibles above its level either.
      ownRowsExempt: false,
      isGreen,
    });
    const byId = new Map(items.map((c) => [c.id, c]));
    const ranked: ListedCrucible[] = [];
    // In rank order, so the cap keeps each creator's best matches.
    for (const id of ids) {
      const crucible = byId.get(id);
      if (!crucible || excluded.has(crucible.userId)) continue;
      const count = perUser.get(crucible.userId) ?? 0;
      if (count >= MAX_HITS_PER_USER) continue;
      perUser.set(crucible.userId, count + 1);
      ranked.push(crucible);
    }
    const kept = await withEntryCounts(ranked);
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
    name: 'semantic-crucible-search',
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
