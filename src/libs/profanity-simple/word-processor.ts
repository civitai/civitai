// Import all NSFW word lists
import blockedWords from '~/utils/metadata/lists/blocked-words.json';

/**
 * NSFW Word Processor Utility
 *
 * Processes NSFW word lists and deduplicates them.
 */

export interface ProcessedWords {
  originalWords: string[];
}

/**
 * Clean and normalize a word by removing regex patterns and special characters
 * Preserves pipe characters (|) used for word boundaries
 */
function cleanWord(word: string): string {
  // Remove regex patterns like \w*, ?, etc. but preserve pipe boundaries
  return word
    .replace(/\\w\*/g, '') // Remove \w*
    .replace(/\?/g, '') // Remove ?
    .replace(/[\[\](){}]/g, '') // Remove brackets and parentheses
    .replace(/[*+]/g, '') // Remove * and + quantifiers
    .trim()
    .toLowerCase();
}

/**
 * Check if a word is valid for processing (not empty, not too short, etc.)
 * Handles boundary words with pipe characters (|word|, |word, word|)
 */
function isValidWord(word: string): boolean {
  const cleaned = cleanWord(word);

  // Extract content without pipe boundaries for length checking
  const contentWithoutPipes = cleaned.replace(/\|/g, '');

  // Dynamic length checking based on boundary markers
  // Boundary words need at least 1 character of content
  // Regular words need at least 2 characters total
  const minLength = cleaned.includes('|') ? 1 : 2;

  return (
    contentWithoutPipes.length >= minLength && // Appropriate minimum length
    !cleaned.includes('\\') && // No remaining regex patterns
    /^[a-z\s\-'|]+$/i.test(cleaned) // Letters, spaces, hyphens, apostrophes, and pipes
  );
}

/**
 * Process the supplied (or default) NSFW word list and return a deduplicated set.
 */
export function processNsfwWords(words: string[] = blockedWords): ProcessedWords {
  const originalWords = Array.from(new Set(words.filter(isValidWord).map(cleanWord))).sort();

  return {
    originalWords,
  };
}

// Cache the processed default list to avoid recomputation
let cachedProcessedWords: ProcessedWords | null = null;

/**
 * Get processed words for the default (full) list (cached for performance).
 */
export function getCachedNsfwWords(): ProcessedWords {
  if (!cachedProcessedWords) {
    cachedProcessedWords = processNsfwWords();
  }
  return cachedProcessedWords;
}

/**
 * Clear the cache (useful for testing or if word lists are updated)
 */
export function clearWordCache(): void {
  cachedProcessedWords = null;
}
