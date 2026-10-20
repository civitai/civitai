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
import { Availability } from '~/shared/utils/prisma/enums';

// Every index the browser searches. A token grants only what is listed here, so an index missing
// from this list stops working in site search rather than being searchable without its rules.
export const BROWSER_SEARCH_INDEXES = [
  MODELS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  ARTICLES_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
] as const;

export const SEARCH_TOKEN_TTL_MS = 60 * 60 * 1000;

export type SearchTokenViewer = { id?: number | null; isModerator?: boolean | null } | null;

/**
 * Filters Meilisearch applies to every query made with the viewer's token, on top of whatever the
 * client sends. Moderators get none.
 */
export function buildSearchRules(viewer?: SearchTokenViewer): Record<string, TokenIndexRules> {
  const rules: Record<string, TokenIndexRules> = Object.fromEntries(
    BROWSER_SEARCH_INDEXES.map((index) => [index, {}])
  );
  if (viewer?.isModerator) return rules;

  const viewerId = Number(viewer?.id);
  const own = Number.isInteger(viewerId) && viewerId > 0 ? ` OR user.id = ${viewerId}` : '';
  rules[MODELS_SEARCH_INDEX] = {
    filter: `(poi != true${own}) AND (availability != ${Availability.Private}${own})`,
  };
  rules[IMAGES_SEARCH_INDEX] = { filter: 'poi != true' };
  return rules;
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
