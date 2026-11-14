import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { SemanticModel3DSearchInput } from '~/server/schema/semantic-model3d-search.schema';
import { getModel3DFeedItemsByIds } from '~/server/services/model3d.service';
import {
  model3dSemanticEligibleText,
  model3dThumbnailLevelText,
} from '~/server/services/semantic-model3d-eligibility';
import {
  isNonModClampOn,
  queryVerdictLevel,
  recordRefusal,
  resolveSemanticBrowsingLevel,
  semanticQueryRefusal,
  type QueryRefusal,
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
} from '~/server/services/semantic-search-client';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

export { MAX_HITS_PER_USER };

type HydratedModel3D = Awaited<ReturnType<typeof getModel3DFeedItemsByIds>>[number];

const searchServiceCandidates = searchServiceSource('models3d', {
  notFoundMessage: '3D model not found',
});

/**
 * The ids among `ids` the semantic search may show at `browsingLevel`: the index's own rule, read
 * from the database now, and both the model's and its thumbnail's level within the viewer's.
 */
export async function eligibleModel3DIds(ids: number[], browsingLevel: number) {
  if (!ids.length) return new Set<number>();
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT m.id
    FROM "Model3D" m
    JOIN "User" u ON u.id = m."userId"
    JOIN "Image" t ON t.id = m."thumbnailImageId"
    WHERE m.id = ANY(${ids}::int[])
      AND ${Prisma.raw(model3dSemanticEligibleText())}
      AND (m."nsfwLevel" & ~${browsingLevel}::int) = 0
      AND (${Prisma.raw(model3dThumbnailLevelText({ ti: 't' }))} & ~${browsingLevel}::int) = 0`;
  return new Set(rows.map((r) => Number(r.id)));
}

export async function searchSemanticModels3D({
  input,
  user,
  track,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticModel3DSearchInput;
  user?: SessionUser;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
}) {
  const none = { items: [] as HydratedModel3D[], nextCursor: undefined, correctedQuery: undefined };
  let browsingLevel = resolveSemanticBrowsingLevel(
    input.browsingLevel,
    user,
    await isNonModClampOn()
  );
  const [hidden, addonData] = await Promise.all([
    getAllHiddenForUser({ userId: user?.id }),
    getBrowsingSettingAddons(),
  ]);
  const addonsFor = (level: number) =>
    resolveBrowsingSettingsAddons(addonData, level, { isModerator: user?.isModerator });
  let addons = addonsFor(browsingLevel);
  const refusalOf = async (text: string, stage: QueryStage) => {
    const refusal = await semanticQueryRefusal(text, {
      browsingLevel,
      disablePoi: addons.disablePoi,
      isModerator: user?.isModerator,
    });
    recordRefusal(track, refusal, text, 'models3d_semantic', stage);
    return refusal;
  };
  const refusal = await refusalOf(input.query, 'query');
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  if (verdictLevel === 'refuse') return none;
  if (verdictLevel !== browsingLevel) {
    browsingLevel = verdictLevel;
    addons = addonsFor(browsingLevel);
  }

  const excludedUserIds = [
    ...new Set(
      [...hidden.hiddenUsers, ...hidden.blockedUsers, ...hidden.blockedByUsers].map((x) => x.id)
    ),
  ];
  const excludedTagIds = [
    ...new Set([
      ...addons.excludedTagIds,
      ...hidden.hiddenTags.filter((x) => x.hidden).map((x) => x.id),
    ]),
  ];
  const excludedUsers = new Set(excludedUserIds);
  const excludedTags = new Set(excludedTagIds);
  const filter: CandidateFilter = {
    gate: { kind: 'level', nsfwLevels: Flags.instanceToArray(browsingLevel) },
    tagIds: input.tagIds,
    excludedTagIds,
    excludedUserIds,
  };

  const perUser = new Map<number, number>();
  let returned = 0;
  let hydrated = 0;
  const hydrate: Hydrate<HydratedModel3D> = async (ids) => {
    // Qdrant only proposes: a point outlives a ban, a hold or a re-rated thumbnail until the
    // ingest catches up, so nothing is shown that the database does not allow now.
    const allowed = await eligibleModel3DIds(ids, browsingLevel);
    const visible = ids.filter((id) => allowed.has(id));
    const byId = new Map(
      (await getModel3DFeedItemsByIds({ ids: visible, user })).map((m) => [m.id, m])
    );
    const kept: HydratedModel3D[] = [];
    // In rank order, so the cap keeps each creator's best matches.
    for (const id of visible) {
      const model = byId.get(id);
      if (!model || excludedUsers.has(model.userId)) continue;
      if (model.tags.some((tagId) => excludedTags.has(tagId))) continue;
      if (input.tagIds?.some((tagId) => !model.tags.includes(tagId))) continue;
      const count = perUser.get(model.userId) ?? 0;
      if (count >= MAX_HITS_PER_USER) continue;
      perUser.set(model.userId, count + 1);
      kept.push(model);
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
    name: 'semantic-model3d-search',
    returned,
    hydrated,
    shown: page.items.length,
  }).catch(() => undefined);

  if (correctedRefusal) return none;
  return { ...page, correctedQuery };
}
