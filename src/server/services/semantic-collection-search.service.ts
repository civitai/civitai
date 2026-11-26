import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { SemanticCollectionSearchInput } from '~/server/schema/semantic-collection-search.schema';
import type { Context } from '~/server/createContext';
import { getAllCollectionsInfiniteHandler } from '~/server/controllers/collection.controller';
import { collectionSemanticEligibleText } from '~/server/services/semantic-collection-eligibility';
import {
  beginSemanticAudit,
  isNonModClampOn,
  queryVerdictLevel,
  recordRefusal,
  refusedTextCandidates,
  resolveSemanticBrowsingLevel,
  semanticQueryRefusal,
  type QueryStage,
  type QueryTracker,
} from '~/server/services/semantic-query-guard';
import {
  MAX_HITS_PER_USER,
  auditedTextCandidates,
  collectPage,
  searchServiceSource,
  viewerExcludedUserIds,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
} from '~/server/services/semantic-search-client';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

export { MAX_HITS_PER_USER };

type HydratedCollection = Awaited<
  ReturnType<typeof getAllCollectionsInfiniteHandler>
>['items'][number];

const searchServiceCandidates = searchServiceSource('collections', {
  notFoundMessage: 'Collection not found',
});

/**
 * The ids among `ids` the semantic search may show at `browsingLevel`: the index's own rule, read
 * from the database now, and the collection's level within the viewer's.
 */
export async function eligibleCollectionIds(ids: number[], browsingLevel: number) {
  if (!ids.length) return new Set<number>();
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT c.id
    FROM "Collection" c
    JOIN "User" u ON u.id = c."userId"
    WHERE c.id = ANY(${ids}::int[])
      AND ${Prisma.raw(collectionSemanticEligibleText())}
      AND (c."nsfwLevel" & ~${browsingLevel}::int) = 0`;
  return new Set(rows.map((r) => Number(r.id)));
}

export async function searchSemanticCollections({
  input,
  ctx,
  track,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticCollectionSearchInput;
  ctx: Context;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
}) {
  const user: SessionUser | undefined = ctx.user;
  const none = {
    items: [] as HydratedCollection[],
    nextCursor: undefined,
    correctedQuery: undefined,
    refused: false as boolean,
  };
  let browsingLevel = resolveSemanticBrowsingLevel(
    input.browsingLevel,
    user,
    await isNonModClampOn(user)
  );
  const [hidden, addonData] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
  ]);
  const addonsFor = (level: number) =>
    resolveBrowsingSettingsAddons(addonData, level, { isModerator: user?.isModerator });
  let addons = addonsFor(browsingLevel);
  const audit = beginSemanticAudit({
    index: 'collections',
    viewer: user,
    query: input.query,
    firstPage: !input.cursor,
  });
  const refusalOf = async (text: string, stage: QueryStage) => {
    const refusal = await semanticQueryRefusal(text, {
      browsingLevel,
      disablePoi: addons.disablePoi,
      isModerator: user?.isModerator,
    });
    recordRefusal(track, refusal, text, 'collections_semantic', stage);
    audit.verdict(refusal);
    return refusal;
  };
  const refusal = await refusalOf(input.query, 'query');
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  const queryRefused = verdictLevel === 'refuse';
  if (!queryRefused && verdictLevel !== browsingLevel) {
    browsingLevel = verdictLevel;
    addons = addonsFor(browsingLevel);
  }

  const excludedUserIds = viewerExcludedUserIds(hidden);
  const excludedUsers = new Set(excludedUserIds);
  const filter: CandidateFilter = {
    gate: { kind: 'level', nsfwLevels: Flags.instanceToArray(browsingLevel) },
    anyOf: { type: input.types },
    userIds: input.userId ? [input.userId] : undefined,
    excludedUserIds,
  };
  // Refused before any search: the audit may run it after the response, for its row only.
  if (queryRefused)
    return audit.refused(
      'refused_query',
      none,
      browsingLevel,
      refusedTextCandidates(candidateSource, {
        text: input.query,
        filter,
        viewer: { isModerator: !!user?.isModerator },
      })
    );

  const perUser = new Map<number, number>();
  let hydrated = 0;
  const hydrate: Hydrate<HydratedCollection> = async (ids) => {
    // Qdrant only proposes: a point outlives a ban, a hold or a re-rating until the ingest catches
    // up, so nothing is shown that the database does not allow now.
    const allowed = await eligibleCollectionIds(ids, browsingLevel);
    const visible = ids.filter((id) => allowed.has(id));
    if (!visible.length) return [];
    // The feed's own read, so covers are servable and capped as they are there.
    const { items } = await getAllCollectionsInfiniteHandler({
      input: { ids: visible, limit: visible.length, browsingLevel },
      ctx,
    });
    const byId = new Map(items.map((c) => [c.id, c]));
    const kept: HydratedCollection[] = [];
    // In rank order, so the cap keeps each creator's best matches.
    for (const id of visible) {
      const collection = byId.get(id);
      if (!collection || excludedUsers.has(collection.userId)) continue;
      if (input.types?.length && (!collection.type || !input.types.includes(collection.type)))
        continue;
      if (input.userId && collection.userId !== input.userId) continue;
      const count = perUser.get(collection.userId) ?? 0;
      if (count >= MAX_HITS_PER_USER) continue;
      perUser.set(collection.userId, count + 1);
      kept.push(collection);
    }
    hydrated += kept.length;
    return kept;
  };

  const search = auditedTextCandidates({
    source: candidateSource,
    viewer: { isModerator: !!user?.isModerator },
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
    name: 'semantic-collection-search',
    hydrated,
    payload: { returned: search.state.returned, shown: page.items.length },
  });

  audit.candidates(search.state.first);
  if (search.state.refused)
    return audit.refused(
      'refused_correction',
      none,
      browsingLevel,
      async () => search.state.first ?? { ids: [] }
    );
  return audit.done({ ...page, correctedQuery: search.state.correctedQuery }, browsingLevel);
}
