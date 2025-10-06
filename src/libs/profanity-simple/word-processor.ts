import nlp from 'compromise';

// Import all NSFW word lists
import blockedWords from '~/utils/metadata/lists/blocked-words.json';

/**
 * NSFW Word Processor Utility
 *
 * Processes NSFW word lists from JSON files, deduplicates them,
 * and generates plurals and conjugations using the compromise package.
 */

export interface ProcessedWords {
  originalWords: string[];
  expandedWords: string[];
  allWords: string[];
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
 * Generate word variations using compromise NLP
 * Skips variation generation for boundary words (containing pipes)
 */
function generateWordVariations(word: string): string[] {
  const variations = new Set<string>();
  const cleaned = cleanWord(word);

  // Add the original cleaned word
  variations.add(cleaned);

  // Skip variation generation for boundary words (containing pipes)
  // Compromise NLP doesn't understand pipe boundary markers
  if (cleaned.includes('|')) {
    return Array.from(variations);
  }

  try {
    const doc = nlp(cleaned);

    // For single words, generate common variations
    if (!cleaned.includes(' ')) {
      // Plurals
      const plural = doc.nouns().toPlural().text();
      if (plural && plural !== cleaned && !plural.includes(' ')) {
        variations.add(plural);
      }

      // Singular form
      const singular = doc.nouns().toSingular().text();
      if (singular && singular !== cleaned && !singular.includes(' ')) {
        variations.add(singular);
      }

      // Verb forms (past, present, future, gerund)
      if (doc.verbs().length > 0) {
        const pastTense = doc.verbs().toPastTense().text();
        const presentTense = doc.verbs().toPresentTense().text();
        const gerund = doc.verbs().toGerund().text();
        const infinitive = doc.verbs().toInfinitive().text();

        [pastTense, presentTense, gerund, infinitive].forEach((form) => {
          if (form && form !== cleaned && form.length > 1 && !form.includes(' ')) {
            variations.add(form);
          }
        });
      }

      // Adjective forms
      if (doc.adjectives().length > 0) {
        const comparative = doc.adjectives().toComparative().text();
        const superlative = doc.adjectives().toSuperlative().text();

        [comparative, superlative].forEach((form) => {
          if (form && form !== cleaned && form.length > 1 && !form.includes(' ')) {
            variations.add(form);
          }
        });
      }
    }
  } catch (error) {
    // If compromise fails, just return the cleaned word
    console.warn(`Failed to process word: ${word}`, error);
  }

  return Array.from(variations).filter((v) => v.length > 1);
}

/**
 * Process all NSFW word lists and return deduplicated, expanded word lists
 */
export function processNsfwWords(): ProcessedWords {
  // Clean and deduplicate original words
  const originalWords = Array.from(new Set(blockedWords.filter(isValidWord).map(cleanWord))).sort();

  // Separate boundary words from regular words
  const boundaryWords = originalWords.filter((word) => word.includes('|'));
  const regularWords = originalWords.filter((word) => !word.includes('|'));

  // Generate variations only for regular words (skip boundary words entirely)
  const expandedWordsSet = new Set<string>();

  regularWords.forEach((word) => {
    const variations = generateWordVariations(word);
    variations.forEach((variation) => expandedWordsSet.add(variation));
  });

  const expandedWords = Array.from(expandedWordsSet).sort();

  // Combine all words: boundary words (as-is) + regular words + filtered expanded words
  const allWords = Array.from(
    new Set([...boundaryWords, ...regularWords, ...expandedWords])
  ).sort();

  return {
    originalWords, // Includes both boundary and regular words
    expandedWords, // Only variations from regular words
    allWords, // Everything combined
  };
}

// Cache the processed words to avoid recomputation
let cachedProcessedWords: ProcessedWords | null = null;

/**
 * Get processed words (cached for performance)
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
