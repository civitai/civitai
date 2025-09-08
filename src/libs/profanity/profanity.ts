import type { FilterConfig } from 'glin-profanity';
import { Filter } from 'glin-profanity';
import { getCachedNsfwWords } from './nsfw-word-processor';

/**
 * Profanity detection and censoring utility
 *
 * Simple functional approach using glin-profanity for advanced UGC filtering
 * with obfuscation detection and fuzzy matching.
 */

const defaultConfig: FilterConfig = {
  languages: ['english', 'spanish', 'japanese', 'chinese', 'korean', 'russian', 'german'],
  caseSensitive: false,
  allowObfuscatedMatch: true,
  fuzzyToleranceLevel: 0.8,
  severityLevels: true,
  enableContextAware: true,
  replaceWith: '***',
  // Basic ignore list for common false positives
  ignoreWords: [
    'assessment',
    'classic',
    'bass',
    'pass',
    'mass',
    'class',
    'glass',
    'grass',
    'Hassaku', // Add specific case user mentioned
  ],
};

/**
 * Get custom words from NSFW metadata lists
 */
function loadCustomWords(): string[] {
  try {
    const { allWords } = getCachedNsfwWords();
    return allWords;
  } catch (error) {
    console.warn('Failed to load NSFW word lists:', error);
    return [];
  }
}

/**
 * Check if text contains profanity
 * @param text - The text to check
 * @param config - Optional configuration overrides
 * @returns true if profanity is detected, false otherwise
 */
export function containsProfanity(text: string, config: Partial<FilterConfig> = {}): boolean {
  const customWords = loadCustomWords();
  const finalConfig = {
    ...defaultConfig,
    ...config,
    customWords,
  };

  const filter = new Filter(finalConfig);
  return filter.isProfane(text);
}

/**
 * Censor profane words in text
 * @param text - The text to censor
 * @param config - Optional configuration overrides
 * @returns The censored text
 */
export function censorProfanity(text: string, config: Partial<FilterConfig> = {}): string {
  const customWords = loadCustomWords();
  const finalConfig = {
    ...defaultConfig,
    ...config,
    customWords,
  };

  const filter = new Filter(finalConfig);
  const result = filter.checkProfanity(text);

  return result.processedText || text;
}

/**
 * Get detailed profanity analysis results
 * @param text - The text to analyze
 * @param config - Optional configuration overrides
 * @returns Detailed analysis results
 */
export function analyzeProfanity(text: string, config: Partial<FilterConfig> = {}) {
  const customWords = loadCustomWords();
  const finalConfig = {
    ...defaultConfig,
    ...config,
    customWords,
  };

  const filter = new Filter(finalConfig);
  return filter.checkProfanity(text);
}

/**
 * Get the current default configuration
 */
export function getDefaultConfig(): FilterConfig {
  return { ...defaultConfig };
}

/**
 * Get the current custom words list (for debugging)
 */
export function getCustomWords(): string[] {
  return loadCustomWords();
}

// Default export with backward compatibility API
const profanityFilter = {
  exists: containsProfanity,
  censor: censorProfanity,
  analyze: analyzeProfanity,
  getDefaultConfig,
  getCustomWords,
};

export default profanityFilter;
