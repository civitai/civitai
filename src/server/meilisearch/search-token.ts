import type { TokenIndexRules } from 'meilisearch';
import { MeiliSearch } from 'meilisearch';
import { indexBrowsingLevelClause } from '~/components/Search/search-filters';
import { env } from '~/env/server';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { RETIRED_SEARCH_INDEXES } from '~/server/search-index/retired-indexes';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Availability } from '~/shared/utils/prisma/enums';

const SITE_SEARCH_INDEXES = [
  MODELS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
];

const grantedIndexes = (retired: readonly string[]) =>
  SITE_SEARCH_INDEXES.filter((index) => !retired.includes(index));

// Every index the browser searches, less the retired ones. A token grants only what is listed
// here, so an index missing from this list stops working in site search rather than being
// searchable without its rules.
export const BROWSER_SEARCH_INDEXES = grantedIndexes(RETIRED_SEARCH_INDEXES);

export const SEARCH_TOKEN_TTL_MS = 60 * 60 * 1000;

export type SearchTokenViewer = {
  id?: number | null;
  isModerator?: boolean | null;
  /** The site's content-level cap; `null` only where the site caps nothing. Missing means SFW. */
  browsingLevelCap?: number | null;
} | null;

function tokenBrowsingLevelCap(viewer?: SearchTokenViewer) {
  const cap = viewer?.browsingLevelCap;
  if (cap === null) return undefined;
  return typeof cap === 'number' && Number.isInteger(cap) && cap > 0 ? cap : sfwBrowsingLevelsFlag;
}

/**
 * Filters Meilisearch applies to every query made with the viewer's token, on top of whatever the
 * client sends. Moderators skip the privacy rules but not the site's content level. A rule key is
 * itself a grant, so a retired index gets no entry at all; its filter stays here so restoring the
 * index restores the filter with it.
 */
export function buildSearchRules(
  viewer?: SearchTokenViewer,
  retired: readonly string[] = RETIRED_SEARCH_INDEXES
): Record<string, TokenIndexRules> {
  const viewerId = Number(viewer?.id);
  const own = Number.isInteger(viewerId) && viewerId > 0 ? ` OR user.id = ${viewerId}` : '';
  const filters: Record<string, string> = viewer?.isModerator
    ? {}
    : {
        [MODELS_SEARCH_INDEX]: `(poi != true${own}) AND (availability != ${Availability.Private}${own})`,
        [IMAGES_SEARCH_INDEX]: 'poi != true',
      };
  const cap = tokenBrowsingLevelCap(viewer);
  return Object.fromEntries(
    grantedIndexes(retired).map((index) => {
      const levelClause = cap === undefined ? null : indexBrowsingLevelClause(index, cap);
      const clauses = [filters[index], levelClause].filter((clause): clause is string => !!clause);
      if (!clauses.length) return [index, {}];
      const filter =
        clauses.length === 1 ? clauses[0] : clauses.map((clause) => `(${clause})`).join(' AND ');
      return [index, { filter }];
    })
  );
}

/** `null` when no signing key is configured: the browser then searches through `/api/search`. */
export function mintSearchToken(
  viewer?: SearchTokenViewer,
  now = Date.now()
): { token: string; expiresAt: number } | null {
  const apiKey = env.SEARCH_TOKEN_API_KEY;
  const apiKeyUid = env.SEARCH_TOKEN_API_KEY_UID;
  if (!apiKey || !apiKeyUid || !env.NEXT_PUBLIC_SEARCH_HOST) return null;

  const expiresAt = now + SEARCH_TOKEN_TTL_MS;
  const client = new MeiliSearch({ host: env.NEXT_PUBLIC_SEARCH_HOST, apiKey });
  const token = client.generateTenantToken(apiKeyUid, buildSearchRules(viewer), {
    expiresAt: new Date(expiresAt),
  });
  return { token, expiresAt };
}
