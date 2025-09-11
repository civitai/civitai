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
 */
function cleanWord(word: string): string {
  // Remove regex patterns like \w*, ?, etc.
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
 */
function isValidWord(word: string): boolean {
  const cleaned = cleanWord(word);
  return (
    cleaned.length > 1 && // At least 2 characters
    !cleaned.includes('\\') && // No remaining regex patterns
    /^[a-z\s-']+$/i.test(cleaned) // Only letters, spaces, hyphens, apostrophes
  );
}

/**
 * Generate word variations using compromise NLP
 */
function generateWordVariations(word: string): string[] {
  const variations = new Set<string>();
  const cleaned = cleanWord(word);

  // Add the original cleaned word
  variations.add(cleaned);

  try {
    const doc = nlp(cleaned);

    // For single words, generate common variations
    if (!cleaned.includes(' ')) {
      // Plurals
      const plural = doc.nouns().toPlural().text();
      if (plural && plural !== cleaned) {
        variations.add(plural);
      }

      // Singular form
      const singular = doc.nouns().toSingular().text();
      if (singular && singular !== cleaned) {
        variations.add(singular);
      }

      // Verb forms (past, present, future, gerund)
      if (doc.verbs().length > 0) {
        const pastTense = doc.verbs().toPastTense().text();
        const presentTense = doc.verbs().toPresentTense().text();
        const gerund = doc.verbs().toGerund().text();
        const infinitive = doc.verbs().toInfinitive().text();

        [pastTense, presentTense, gerund, infinitive].forEach((form) => {
          if (form && form !== cleaned && form.length > 1) {
            variations.add(form);
          }
        });
      }

      // Adjective forms
      if (doc.adjectives().length > 0) {
        const comparative = doc.adjectives().toComparative().text();
        const superlative = doc.adjectives().toSuperlative().text();

        [comparative, superlative].forEach((form) => {
          if (form && form !== cleaned && form.length > 1) {
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

  // Generate variations for all words
  const expandedWordsSet = new Set<string>();

  originalWords.forEach((word) => {
    const variations = generateWordVariations(word);
    variations.forEach((variation) => expandedWordsSet.add(variation));
  });

  const expandedWords = Array.from(expandedWordsSet).sort();
  const allWords = Array.from(new Set([...originalWords, ...expandedWords])).sort();

  return {
    originalWords,
    expandedWords,
    allWords,
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
