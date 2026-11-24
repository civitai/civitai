import { includesInappropriate, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { getBlockedNsfwWords } from '~/utils/metadata/audit-base';
import { SEARCH_REFUSED_CODE } from '~/shared/constants/search-refusal.constants';

export type SearchRefusal = 'illegal' | 'profanity' | 'poi' | 'blocked-words';

/**
 * Whether the browser runs its own profanity check on a search: not where every request reaches
 * the server, which always checks. That is the semantic search procedures, and /api/search only
 * with the search proxy on, since without it the browser can query Meilisearch directly.
 */
export function browserChecksProfanity({
  via,
  proxyEnabled,
}: {
  via: 'semantic' | 'siteSearch';
  proxyEnabled: boolean;
}): boolean {
  return via === 'siteSearch' && !proxyEnabled;
}

/**
 * A search the server refused for profanity: a semantic search's tRPC error, or an /api/search
 * answer as the site client and the Meilisearch adapter rethrow it. Carries no matched word.
 */
export function isSearchRefusedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message, data } = error as { code?: unknown; message?: unknown; data?: unknown };
  if (code === SEARCH_REFUSED_CODE) return true;
  if ((data as { code?: unknown } | undefined)?.code === 'UNPROCESSABLE_CONTENT')
    return message === SEARCH_REFUSED_CODE;
  return typeof message === 'string' && message.includes(SEARCH_REFUSED_CODE);
}

/**
 * Why a search text is refused before anything searches it, or undefined when it may run. Profanity
 * is the one refusal not decided here: it needs the `useCheckProfanity` hook, and only applies on
 * the green domain.
 */
export function getSearchRefusal({
  text,
  auditedText,
  disablePoi,
}: {
  text: string;
  /** `text` with the moderator-whitelisted benign phrases stripped. */
  auditedText: string;
  disablePoi: boolean;
}): Exclude<SearchRefusal, 'profanity'> | undefined {
  if (!text) return undefined;
  if (includesInappropriate({ prompt: auditedText }, !!includesNsfw(text)) === 'minor')
    return 'illegal';
  if (disablePoi && includesPoi(auditedText)) return 'poi';
  // Raw text on purpose: this reads a different list (blocked NSFW words) which the benign
  // phrases do not carve out, and it blocks rather than flags.
  if (getBlockedNsfwWords(text).length) return 'blocked-words';
  return undefined;
}
