import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { SemanticStorylineSearchInput } from '~/server/schema/semantic-storyline-search.schema';
import {
  isNonModClampOn,
  queryVerdictLevel,
  recordRefusal,
  resolveSemanticBrowsingLevel,
  semanticQueryRefusal,
  type QueryStage,
  type QueryTracker,
} from '~/server/services/semantic-query-guard';
import {
  MAX_HITS_PER_USER,
  collectPage,
  searchServiceSource,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
  auditedTextCandidates,
  viewerExcludedUserIds,
} from '~/server/services/semantic-search-client';
import { getStorylinesInfinite } from '~/server/services/storyline.service';
import {
  storyLevelText,
  storylineSemanticEligibleText,
} from '~/server/services/storyline-visibility.sql';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

export { MAX_HITS_PER_USER };

type HydratedStoryline = Awaited<ReturnType<typeof getStorylinesInfinite>>['items'][number];

const searchServiceCandidates = searchServiceSource('storylines', {
  notFoundMessage: 'Storyline not found',
});

/**
 * The ids among `ids` the semantic search may show at `browsingLevel`: the index's own rule, read
 * from the database now, chapter 1 published by now (its text is indexed before then), and the
 * story's level matching the viewer's as the feed matches it.
 */
export async function eligibleStorylineIds(ids: number[], browsingLevel: number) {
  if (!ids.length) return new Set<number>();
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT st.id
    FROM "Storyline" st
    JOIN "User" u ON u.id = st."userId"
    LEFT JOIN "StorylineChapter" rc ON rc."storylineId" = st.id AND rc.depth = 0
    LEFT JOIN "Post" rp ON rp.id = rc."postId"
    LEFT JOIN "User" ru ON ru.id = rp."userId"
    WHERE st.id = ANY(${ids}::int[])
      AND ${Prisma.raw(storylineSemanticEligibleText())}
      AND rp."publishedAt" <= now()
      AND (${Prisma.raw(storyLevelText())} & ${browsingLevel}::int) <> 0`;
  return new Set(rows.map((r) => Number(r.id)));
}

export async function searchSemanticStorylines({
  input,
  user,
  track,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticStorylineSearchInput;
  user?: SessionUser;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
}) {
  const none = {
    items: [] as HydratedStoryline[],
    nextCursor: undefined,
    correctedQuery: undefined,
  };
  let browsingLevel = resolveSemanticBrowsingLevel(
    input.browsingLevel,
    user,
    await isNonModClampOn()
  );
  const [hidden, addonData] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
  ]);
  const { disablePoi } = resolveBrowsingSettingsAddons(addonData, browsingLevel, {
    isModerator: user?.isModerator,
  });
  const refusalOf = async (text: string, stage: QueryStage) => {
    const refusal = await semanticQueryRefusal(text, {
      browsingLevel,
      disablePoi,
      isModerator: user?.isModerator,
    });
    recordRefusal(track, refusal, text, 'storylines_semantic', stage);
    return refusal;
  };
  const refusal = await refusalOf(input.query, 'query');
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  if (verdictLevel === 'refuse') return none;
  browsingLevel = verdictLevel;

  const excludedUserIds = viewerExcludedUserIds(hidden);
  // Read once: every page of one search shares the same cutoff.
  const now = new Date().toISOString();
  const filter: CandidateFilter = {
    gate: { kind: 'level', nsfwLevels: Flags.instanceToArray(browsingLevel) },
    excludedUserIds,
    // A scheduled chapter 1 is indexed before it is published.
    range: { key: 'rootPublishedAt', lte: now },
    anyOf: { status: input.status ? [input.status] : undefined },
  };

  const perUser = new Map<number, number>();
  let hydrated = 0;
  const hydrate: Hydrate<HydratedStoryline> = async (ids) => {
    // Qdrant only proposes: a point outlives a ban, a hold or a re-rating until the ingest
    // catches up, so nothing is shown that the database does not allow now.
    const allowed = await eligibleStorylineIds(ids, browsingLevel);
    const visible = ids.filter((id) => allowed.has(id));
    if (!visible.length) return [];
    // The feed's own read then applies the viewer's view: hidden and blocked creators, and the
    // cover, gated per image for this viewer.
    const { items } = await getStorylinesInfinite({
      ids: visible,
      filter: 'all',
      sort: 'newest',
      limit: visible.length,
      viewer: user,
      browsingLevel,
    });
    const byId = new Map(items.map((s) => [s.id, s]));
    const kept: HydratedStoryline[] = [];
    // In rank order, so the cap keeps each creator's best matches.
    for (const id of visible) {
      const storyline = byId.get(id);
      if (!storyline) continue;
      if (input.status && storyline.status !== input.status) continue;
      const count = perUser.get(storyline.user.id) ?? 0;
      if (count >= MAX_HITS_PER_USER) continue;
      perUser.set(storyline.user.id, count + 1);
      kept.push(storyline);
    }
    hydrated += kept.length;
    return kept;
  };

  const search = auditedTextCandidates({
    source: candidateSource,
    text: input.query,
    filter,
    audit: (correction) => refusalOf(correction, 'correction'),
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
    name: 'semantic-storyline-search',
    returned: search.state.returned,
    hydrated,
    shown: page.items.length,
  }).catch(() => undefined);

  if (search.state.refused) return none;
  return { ...page, correctedQuery: search.state.correctedQuery };
}
