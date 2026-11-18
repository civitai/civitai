import { Prisma } from '@prisma/client';
import { BountySort, NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { Context } from '~/server/createContext';
import type { SemanticBountySearchInput } from '~/server/schema/semantic-bounty-search.schema';
import { getInfiniteBountiesHandler } from '~/server/controllers/bounty.controller';
import { bountySemanticEligibleText } from '~/server/services/semantic-bounty-eligibility';
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
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import type { SessionUser } from '~/types/session';

export { MAX_HITS_PER_USER };

type HydratedBounty = Awaited<ReturnType<typeof getInfiniteBountiesHandler>>['items'][number];

const searchServiceCandidates = searchServiceSource('bounties', {
  notFoundMessage: 'Bounty not found',
});

/**
 * The ids among `ids` the semantic search may show at `browsingLevel`: the index's own rule, read
 * from the database now, and the level the feed serves it at (XXX when marked nsfw) within the
 * viewer's.
 */
export async function eligibleBountyIds(ids: number[], browsingLevel: number) {
  if (!ids.length) return new Set<number>();
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT b.id
    FROM "Bounty" b
    JOIN "User" u ON u.id = b."userId"
    WHERE b.id = ANY(${ids}::int[])
      AND ${Prisma.raw(bountySemanticEligibleText())}
      AND ((CASE WHEN b.nsfw THEN ${NsfwLevel.XXX}::int ELSE b."nsfwLevel" END)
        & ~${browsingLevel}::int) = 0`;
  return new Set(rows.map((r) => Number(r.id)));
}

export async function searchSemanticBounties({
  input,
  ctx,
  track,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticBountySearchInput;
  ctx: Context;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
}) {
  const user: SessionUser | undefined = ctx.user;
  const none = {
    items: [] as HydratedBounty[],
    nextCursor: undefined,
    correctedQuery: undefined,
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
    index: 'bounties',
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
    recordRefusal(track, refusal, text, 'bounties_semantic', stage);
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
  const excludedTags = new Set([
    ...addons.excludedTagIds,
    ...hidden.hiddenTags.filter((x) => x.hidden).map((x) => x.id),
  ]);
  const filter: CandidateFilter = {
    gate: { kind: 'level', nsfwLevels: Flags.instanceToArray(browsingLevel) },
    anyOf: {
      type: input.types,
      mode: input.mode ? [input.mode] : undefined,
      baseModel: input.baseModels,
    },
    userIds: input.userId ? [input.userId] : undefined,
    excludedUserIds,
  };
  // Refused before any search: the audit may run it after the response, for its row only.
  if (queryRefused)
    return audit.refused(
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
  const hydrate: Hydrate<HydratedBounty> = async (ids) => {
    // Qdrant only proposes: a point outlives a ban, a hold or a re-rating until the ingest catches
    // up, so nothing is shown that the database does not allow now.
    const allowed = await eligibleBountyIds(ids, browsingLevel);
    const visible = ids.filter((id) => allowed.has(id));
    if (!visible.length) return [];
    // The feed's own query, so its status, type, mode and base-model filters hold as they do there.
    const { items } = await getInfiniteBountiesHandler({
      input: {
        ids: visible,
        limit: visible.length,
        types: input.types,
        mode: input.mode,
        status: input.status,
        baseModels: input.baseModels,
        period: MetricTimeframe.AllTime,
        sort: BountySort.Newest,
      },
      ctx,
    });
    const byId = new Map(items.map((b) => [b.id, b]));
    const kept: HydratedBounty[] = [];
    // In rank order, so the cap keeps each creator's best matches.
    for (const id of visible) {
      const bounty = byId.get(id);
      if (!bounty || excludedUsers.has(bounty.user.id)) continue;
      if (input.userId && bounty.user.id !== input.userId) continue;
      if (bounty.tags.some((tagId) => excludedTags.has(tagId))) continue;
      // The feed caps images only to the domain; this search may have narrowed the level further,
      // and a bounty's own level can sit below its images' (a moderator override, a re-rating the
      // level job has not caught up with). A bounty left with no image is dropped, as on the feed.
      const images = bounty.images.filter(
        (image) => !!image.nsfwLevel && (image.nsfwLevel & ~browsingLevel) === 0
      );
      if (!images.length) continue;
      const count = perUser.get(bounty.user.id) ?? 0;
      if (count >= MAX_HITS_PER_USER) continue;
      perUser.set(bounty.user.id, count + 1);
      kept.push({ ...bounty, images });
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
    name: 'semantic-bounty-search',
    hydrated,
    payload: { returned: search.state.returned, shown: page.items.length },
  });

  audit.candidates(search.state.first);
  if (search.state.refused)
    return audit.refused(none, browsingLevel, async () => search.state.first ?? { ids: [] });
  return audit.done({ ...page, correctedQuery: search.state.correctedQuery }, browsingLevel);
}
