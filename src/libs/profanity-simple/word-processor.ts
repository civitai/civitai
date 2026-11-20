import { blockedWords } from '@civitai/mod-utils/profanity/lists';
import { cleanWord, isValidWord } from '@civitai/mod-utils/profanity/word-rules';

/**
 * NSFW Word Processor Utility
 *
 * Processes NSFW word lists and deduplicates them.
 */

export interface ProcessedWords {
  originalWords: string[];
}

/**
 * Process a blocked word list (the shipped one by default) and return the deduplicated words
 */
export function processNsfwWords(words: readonly string[] = blockedWords): ProcessedWords {
  const originalWords = Array.from(new Set(words.filter(isValidWord).map(cleanWord))).sort();

  return {
    originalWords,
  };
}

let cachedProcessedWords: ProcessedWords | null = null;

// Keyed by array identity: a managed list arrives once per fetched response, so a new array
// means a new list. Bounded like the filter cache it feeds.
const MAX_CACHED_MANAGED_LISTS = 2;
const cachedManagedWords = new Map<readonly string[], ProcessedWords>();

/**
 * Get processed words (cached for performance). `null` is the shipped list.
 */
export function getCachedNsfwWords(managedWords: readonly string[] | null = null): ProcessedWords {
  if (managedWords === null) {
    if (!cachedProcessedWords) cachedProcessedWords = processNsfwWords();
    return cachedProcessedWords;
  }

  let processed = cachedManagedWords.get(managedWords);
  if (!processed) {
    processed = processNsfwWords(managedWords);
    if (cachedManagedWords.size >= MAX_CACHED_MANAGED_LISTS) {
      const oldest = cachedManagedWords.keys().next().value;
      if (oldest !== undefined) cachedManagedWords.delete(oldest);
    }
    cachedManagedWords.set(managedWords, processed);
  }
  return processed;
}

/**
 * Clear the cache (useful for testing or if word lists are updated)
 */
export function clearWordCache(): void {
  cachedProcessedWords = null;
  cachedManagedWords.clear();
}
