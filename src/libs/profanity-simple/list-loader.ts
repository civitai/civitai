import { createProfanityFilter, type SimpleProfanityFilter } from '~/libs/profanity-simple';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import displayBootstrap from '~/utils/metadata/lists/profanity-display.json';
import searchBootstrap from '~/utils/metadata/lists/profanity-search.json';

export type ProfanityListKind = 'display' | 'search';

const CACHE_TTL_MS = 5 * 60 * 1000;

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
  expiresAt: number;
}

const cache = new Map<ProfanityListKind, CacheEntry>();
const inflight = new Map<ProfanityListKind, Promise<CacheEntry>>();

async function fetchAndBuild(kind: ProfanityListKind): Promise<CacheEntry> {
  let words: string[];
  try {
    const stored = await dbKV.get<string[]>(KV_KEY[kind]);
    if (Array.isArray(stored) && stored.length > 0 && stored.every((w) => typeof w === 'string')) {
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

  const filter = createProfanityFilter({ blockedWords: words });
  const entry: CacheEntry = { words, filter, expiresAt: Date.now() + CACHE_TTL_MS };
  cache.set(kind, entry);
  return entry;
}

async function getCacheEntry(kind: ProfanityListKind): Promise<CacheEntry> {
  const cached = cache.get(kind);
  if (cached && cached.expiresAt > Date.now()) return cached;

  // Coalesce concurrent refreshes per kind so the matcher is built once.
  const existing = inflight.get(kind);
  if (existing) return existing;

  const promise = fetchAndBuild(kind).finally(() => inflight.delete(kind));
  inflight.set(kind, promise);
  return promise;
}

export async function loadProfanityList(kind: ProfanityListKind): Promise<string[]> {
  return (await getCacheEntry(kind)).words;
}

export async function getProfanityFilter(kind: ProfanityListKind): Promise<SimpleProfanityFilter> {
  return (await getCacheEntry(kind)).filter;
}

export function clearProfanityListCache(kind?: ProfanityListKind): void {
  if (kind) cache.delete(kind);
  else cache.clear();
}
