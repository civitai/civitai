import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { SemanticComicSearchInput } from '~/server/schema/semantic-comic-search.schema';
import {
  getComicSearchRecords,
  type ComicSearchIndexRecord,
} from '~/server/search-index/comics.search-index';
import { shapeComicHit } from '~/server/services/site-search.service';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { getBrowsingSettingAddons } from '~/server/services/system-cache';
import {
  queryVerdictLevel,
  recordRefusal,
  resolveSemanticBrowsingLevel,
  semanticQueryRefusal,
  type QueryRefusal,
  type QueryStage,
  type QueryTracker,
  isNonModClampOn,
} from '~/server/services/semantic-query-guard';
import {
  MAX_HITS_PER_USER,
  collectPage,
  searchServiceSource,
  type CandidateFilter,
  type CandidateSource,
  type Hydrate,
} from '~/server/services/semantic-search-client';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import type { SessionUser } from '~/types/session';

export { MAX_HITS_PER_USER };

const searchServiceCandidates = searchServiceSource('comics', {
  notFoundMessage: 'Comic not found',
});

/**
 * Every rated level whose bits all lie inside `browsingLevel`. A comic's level is its chapters'
 * levels combined, and the comics feed lists one only when all of them are allowed (as the
 * Meilisearch comics filter does); an unrated comic is left out.
 */
export function levelsWithin(browsingLevel: number) {
  // Only real level bits: the input is unbounded, and the submasks double with each bit.
  const level = browsingLevel & (allBrowsingLevelsFlag | NsfwLevel.Blocked);
  const levels: number[] = [];
  for (let m = level; m > 0; m = (m - 1) & level) levels.push(m);
  return levels.sort((a, b) => a - b);
}

const withinLevel = (levels: number[], browsingLevel: number) => {
  const level = Flags.arrayToInstance(levels);
  return level > 0 && (level & ~browsingLevel) === 0;
};

export async function searchSemanticComics({
  input,
  user,
  browsingLevelCap,
  track,
  candidateSource = searchServiceCandidates,
}: {
  input: SemanticComicSearchInput;
  user?: SessionUser;
  /** The site's cap (requestDomainBrowsingLevelCap); undefined on an uncapped site. */
  browsingLevelCap: number | undefined;
  track?: QueryTracker;
  candidateSource?: CandidateSource;
}) {
  const none = {
    items: [] as ComicSearchIndexRecord[],
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
    recordRefusal(track, refusal, text, 'comics_semantic', stage);
    return refusal;
  };
  const refusal = await refusalOf(input.query, 'query');
  const verdictLevel = queryVerdictLevel(refusal, browsingLevel, user?.isModerator);
  if (verdictLevel === 'refuse') return none;
  browsingLevel = verdictLevel;

  const excludedUserIds = [
    ...new Set(
      [...hidden.hiddenUsers, ...hidden.blockedUsers, ...hidden.blockedByUsers].map((x) => x.id)
    ),
  ];
  const excluded = new Set(excludedUserIds);
  const filter: CandidateFilter = {
    gate: { kind: 'level', nsfwLevels: levelsWithin(browsingLevel) },
    excludedUserIds,
    anyOf: { genre: input.genres?.length ? input.genres : undefined },
  };

  const perUser = new Map<number, number>();
  let returned = 0;
  let hydrated = 0;
  const hydrate: Hydrate<ComicSearchIndexRecord> = async (ids) => {
    // The index's own rows and rule: Qdrant only proposes candidates, and a point can outlive the
    // comic's eligibility (a ban or a flagged panel changes no project row).
    const records = await getComicSearchRecords(dbRead, ids);
    const byId = new Map(records.map((c) => [c.id, c]));
    const kept: ComicSearchIndexRecord[] = [];
    // In rank order, so the cap keeps each creator's best matches.
    for (const id of ids) {
      const comic = byId.get(id);
      if (!comic || comic.user.deletedAt) continue;
      // The payload's level can be stale; the viewer's level is checked again on the row.
      if (!withinLevel(comic.nsfwLevel, browsingLevel)) continue;
      if (excluded.has(comic.userId)) continue;
      const count = perUser.get(comic.userId) ?? 0;
      if (count >= MAX_HITS_PER_USER) continue;
      perUser.set(comic.userId, count + 1);
      // A capped site's cover rule, as the search proxy applies it to Meilisearch hits.
      kept.push(shapeComicHit(comic, browsingLevelCap) as ComicSearchIndexRecord);
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
    name: 'semantic-comic-search',
    returned,
    hydrated,
    shown: page.items.length,
  }).catch(() => undefined);

  if (correctedRefusal) return none;
  return { ...page, correctedQuery };
}
