import type { TokenIndexRules } from 'meilisearch';
import { MeiliSearch } from 'meilisearch';
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

export type SearchTokenViewer = { id?: number | null; isModerator?: boolean | null } | null;

/**
 * Filters Meilisearch applies to every query made with the viewer's token, on top of whatever the
 * client sends. Moderators get none. A rule key is itself a grant, so a retired index gets no
 * entry at all; its filter stays here so restoring the index restores the filter with it.
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
  return Object.fromEntries(
    grantedIndexes(retired).map((index) => [
      index,
      filters[index] ? { filter: filters[index] } : {},
    ])
  );
}

/** `null` when no signing key is configured: the browser then falls back to the shared key. */
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
