import { includesInappropriate, includesNsfw, includesPoi } from '~/utils/metadata/audit';
import { getBlockedNsfwWords } from '~/utils/metadata/audit-base';
import {
  SEARCH_REFUSED_CODE,
  type SearchRefusedBy,
} from '~/shared/constants/search-refusal.constants';

/** `policy`: refused by the server, which names no check to anyone but a moderator. */
export type SearchRefusal = 'illegal' | 'profanity' | 'poi' | 'blocked-words' | 'policy';

/**
 * The server's refusal of a semantic search, read from its first page: never from a placeholder
 * page the previous search left showing. `refusedBy` is there for a moderator only.
 */
export function pageRefusal(
  page: { refused?: boolean; refusedBy?: SearchRefusedBy } | undefined,
  isPlaceholderData?: boolean
): { refusedBy?: SearchRefusedBy } | undefined {
  if (isPlaceholderData || page?.refused !== true) return undefined;
  return page.refusedBy ? { refusedBy: page.refusedBy } : {};
}

/**
 * A search page the server refused, rethrown as the refusal the search clients already read
 * (`isSearchRefusedError`), so the search pages show it instead of "no results".
 */
export function throwIfRefused<T extends object>(page: T): T {
  if ((page as { refused?: unknown }).refused === true)
    throw Object.assign(new Error(SEARCH_REFUSED_CODE), { code: SEARCH_REFUSED_CODE });
  return page;
}

/** The check a refusal decided in the browser names, for a moderator's line. */
export function refusedByOf(refusal: SearchRefusal): SearchRefusedBy | undefined {
  switch (refusal) {
    case 'illegal':
      return 'minor';
    case 'profanity':
      return 'profanity';
    case 'poi':
      return 'real people';
    case 'blocked-words':
      return 'blocked words';
    default:
      return undefined;
  }
}

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
