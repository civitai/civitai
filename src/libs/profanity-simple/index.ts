/**
 * Simple Profanity Filter - Focused implementation using obscenity + compromise
 *
 * This is a streamlined profanity detection system that:
 * - Uses obscenity package for core profanity detection (includes leetspeak handling)
 * - Uses compromise to generate word variations (plurals, conjugations)
 * - Extends word dictionary with metadata words
 * - Provides synchronous operations for React components
 */

import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
  DataSet,
  asteriskCensorStrategy,
  grawlixCensorStrategy,
  assignIncrementingIds,
  pattern,
} from 'obscenity';

import { getCachedNsfwWords } from './word-processor';
import whitelistWords from '~/utils/metadata/lists/whitelist-words.json';

export interface ProfanityFilterOptions {
  /** How to replace profane words */
  replacementStyle: 'asterisk' | 'grawlix' | 'remove';
}

/**
 * Create mappings between whitelist words and profane substrings they contain
 * Optimized to avoid repeated toLowerCase() calls
 */
function createWhitelistMappings(
  profaneWords: string[],
  whitelist: string[]
): Map<string, string[]> {
  const mappings = new Map<string, string[]>();

  // Preprocess whitelist to lowercase once for efficiency
  const lowerWhitelist = whitelist.map((word) => ({
    original: word,
    lower: word.toLowerCase(),
  }));

  // For each profane word, find whitelist words that contain it as a substring
  profaneWords.forEach((profaneWord) => {
    const lowerProfane = profaneWord.toLowerCase();

    const matchingWhitelistWords = lowerWhitelist
      .filter(({ lower }) => lower.includes(lowerProfane) && lower !== lowerProfane)
      .map(({ original }) => original);

    if (matchingWhitelistWords.length > 0) {
      mappings.set(profaneWord, matchingWhitelistWords);
    }
  });

  return mappings;
}

export class SimpleProfanityFilter {
  private matcher!: RegExpMatcher;
  private censor!: TextCensor;
  private options: ProfanityFilterOptions;
  private dataset: DataSet<{ originalWord: string }>;
  private whitelistMappings: Map<string, string[]>;
  private readonly nsfwWords: ReturnType<typeof getCachedNsfwWords>;

  constructor(options: Partial<ProfanityFilterOptions> = {}) {
    this.options = {
      replacementStyle: 'asterisk',
      ...options,
    };

    // Cache NSFW words once during construction
    this.nsfwWords = getCachedNsfwWords();

    // Initialize dataset with default English dictionary
    this.dataset = new DataSet();
    this.dataset.addAll(englishDataset);

    // Initialize whitelist mappings
    this.whitelistMappings = createWhitelistMappings(this.nsfwWords.originalWords, whitelistWords);

    this.initializeMatcher();
    this.initializeCensor();
  }

  /**
   * Check if text contains profanity
   */
  isProfane(text: string): boolean {
    return this.matcher.hasMatch(text);
  }

  /**
   * Clean profane words from text
   */
  clean(text: string): string {
    const matches = this.matcher.getAllMatches(text);
    return this.censor.applyTo(text, matches);
  }

  /**
   * Get detailed information about matches
   */
  analyze(text: string) {
    const matches = this.matcher.getAllMatches(text, true); // sorted by position

    if (matches.length === 0) {
      return {
        isProfane: false,
        matchCount: 0,
        matches: [],
        matchedWords: [],
      };
    }

    // Efficiently extract unique original words and full words in single pass
    const uniqueWords = new Set<string>();
    const matchedWordsSet = new Set<string>();

    matches.forEach((match) => {
      const { phraseMetadata, startIndex, endIndex } =
        this.dataset.getPayloadWithPhraseMetadata(match);
      const originalWord = phraseMetadata?.originalWord;
      if (originalWord) {
        uniqueWords.add(originalWord);
      }

      // Extract the full word that contains the profane text
      // Fix: getPayloadWithPhraseMetadata returns endIndex that's 1 less than it should be
      const fullWord = this.extractFullWord(text, startIndex, endIndex + 1);

      // Add the full word context
      if (fullWord.trim()) {
        matchedWordsSet.add(fullWord);
      }
    });

    return {
      isProfane: true,
      matchCount: matches.length,
      matches: Array.from(uniqueWords),
      matchedWords: Array.from(matchedWordsSet),
    };
  }

  /**
   * Extract the full word that contains the profane substring
   */
  private extractFullWord(text: string, matchStart: number, matchEnd: number): string {
    // Find word boundaries - look for whitespace, punctuation, or string boundaries
    const wordBoundaryRegex = /[\s\W]/;

    // Find start of word (go backwards from match start)
    let wordStart = matchStart;
    while (wordStart > 0 && !wordBoundaryRegex.test(text[wordStart - 1])) {
      wordStart--;
    }

    // Find end of word (go forwards from match end)
    let wordEnd = matchEnd;
    while (wordEnd < text.length && !wordBoundaryRegex.test(text[wordEnd])) {
      wordEnd++;
    }

    return text.substring(wordStart, wordEnd);
  }

  private initializeMatcher(): void {
    // Always add extended words from metadata
    this.dataset = this.extendWithCustomDataset(this.dataset);

    // Build the matcher
    const builtDataset = this.dataset.build();
    this.matcher = new RegExpMatcher({
      ...builtDataset,
      ...englishRecommendedTransformers, // Includes leetspeak handling
    });
  }

  private initializeCensor(): void {
    this.censor = new TextCensor();

    // Set replacement strategy - we use custom logic in cleanWithCustomLogic instead
    switch (this.options.replacementStyle) {
      case 'asterisk':
        this.censor.setStrategy(asteriskCensorStrategy());
        break;
      case 'grawlix':
        this.censor.setStrategy(grawlixCensorStrategy());
        break;
      case 'remove':
        this.censor.setStrategy(() => ''); // Remove completely
        break;
    }
  }

  private extendWithCustomDataset(
    dataset: DataSet<{ originalWord: string }>
  ): DataSet<{ originalWord: string }> {
    // Use the cached NSFW words to avoid repeated calls
    const wordsToAdd = this.nsfwWords.originalWords; // includes both original words only for now
    const filteredWords = wordsToAdd.filter((word) => word.length >= 3); // Filter out very short words

    // Early return if no words to add
    if (filteredWords.length === 0) {
      return dataset;
    }

    const patterns = assignIncrementingIds(filteredWords.map((word) => pattern`${word}`));

    // Add words to dataset with their whitelisted terms
    patterns.forEach((p, index) => {
      const word = filteredWords[index];
      const whitelistTerms = this.whitelistMappings.get(word) || [];

      const phrase = dataset.addPhrase((phrase) => {
        let phraseBuilder = phrase
          .setMetadata({ originalWord: word.replace(/\|/g, '') })
          .addPattern(p.pattern);

        // Add whitelisted terms to this phrase (optimize for common case of no terms)
        if (whitelistTerms.length > 0) {
          whitelistTerms.forEach((whitelistedTerm) => {
            phraseBuilder = phraseBuilder.addWhitelistedTerm(whitelistedTerm);
          });
        }

        return phraseBuilder;
      });

      dataset = phrase;
    });

    return dataset;
  }

  /**
   * Update the filter options and rebuild
   */
  updateOptions(newOptions: Partial<ProfanityFilterOptions>): void {
    this.options = { ...this.options, ...newOptions };
    this.initializeCensor(); // Only need to reinitialize censor since matcher doesn't use these options
  }
}

// Factory function for easy use
export function createProfanityFilter(
  options?: Partial<ProfanityFilterOptions>
): SimpleProfanityFilter {
  return new SimpleProfanityFilter(options);
}
