import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import blockedWords from '~/utils/metadata/lists/blocked-words.json';
import displayBootstrap from '~/utils/metadata/lists/profanity-display.json';

export type ProfanityListKind = 'display' | 'search';

const CACHE_TTL_MS = 5 * 60 * 1000;

const KV_KEY: Record<ProfanityListKind, string> = {
  display: 'profanity:display-list',
  search: 'profanity:search-list',
};

const BOOTSTRAP: Record<ProfanityListKind, string[]> = {
  display: displayBootstrap,
  search: blockedWords,
};

interface CacheEntry {
  words: string[];
  expiresAt: number;
}

const cache = new Map<ProfanityListKind, CacheEntry>();

export async function loadProfanityList(kind: ProfanityListKind): Promise<string[]> {
  const now = Date.now();
  const cached = cache.get(kind);
  if (cached && cached.expiresAt > now) return cached.words;

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

  cache.set(kind, { words, expiresAt: now + CACHE_TTL_MS });
  return words;
}

export function clearProfanityListCache(kind?: ProfanityListKind): void {
  if (kind) cache.delete(kind);
  else cache.clear();
}
