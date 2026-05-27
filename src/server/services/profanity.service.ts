import { createProfanityFilter, type SimpleProfanityFilter } from '~/libs/profanity-simple';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import { createLruCache } from '~/server/utils/lru-cache';
import displayBootstrap from '~/utils/metadata/lists/profanity-display.json';
import searchBootstrap from '~/utils/metadata/lists/profanity-search.json';

export type ProfanityListKind = 'display' | 'search';

const KV_KEY: Record<ProfanityListKind, string> = {
  display: 'profanity:display-list',
  search: 'profanity:search-list',
};

const BOOTSTRAP: Record<ProfanityListKind, string[]> = {
  display: displayBootstrap,
  search: searchBootstrap,
};

interface CacheEntry {
  words: string[];
  filter: SimpleProfanityFilter;
}

const profanityListCache = createLruCache<ProfanityListKind, CacheEntry>({
  name: 'profanity-list',
  max: 2,
  ttl: 5 * 60 * 1000,
  keyFn: (kind) => kind,
  fetchFn: async (kind) => {
    let words: string[];
    try {
      const stored = await dbKV.get<string[]>(KV_KEY[kind]);
      if (
        Array.isArray(stored) &&
        stored.length > 0 &&
        stored.every((w) => typeof w === 'string')
      ) {
        words = stored;
      } else {
        if (stored != null) {
          logToAxiom(
            { type: 'profanity-list-loader', kind, reason: 'invalid-kv-payload' },
            'webhooks'
          ).catch(() => undefined);
        }
        words = BOOTSTRAP[kind];
      }
    } catch (error) {
      logToAxiom(
        {
          type: 'profanity-list-loader',
          kind,
          reason: 'kv-fetch-failed',
          error: error instanceof Error ? error.message : String(error),
        },
        'webhooks'
      ).catch(() => undefined);
      words = BOOTSTRAP[kind];
    }

    return { words, filter: createProfanityFilter({ blockedWords: words }) };
  },
});

export async function loadProfanityList(kind: ProfanityListKind): Promise<string[]> {
  return (await profanityListCache.fetch(kind)).words;
}

export async function getProfanityFilter(kind: ProfanityListKind): Promise<SimpleProfanityFilter> {
  return (await profanityListCache.fetch(kind)).filter;
}

export function clearProfanityListCache(kind?: ProfanityListKind): void {
  if (kind) profanityListCache.delete(kind);
  else profanityListCache.clear();
}
